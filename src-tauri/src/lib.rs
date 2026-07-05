use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputFormat {
    Gif,
    Webp,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertResult {
    output_path: String,
    file_size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    width: u64,
    height: u64,
    fps: f64,
    duration: f64,
    is_static_image: bool,
}

#[tauri::command]
async fn convert_file(
    input_path: String,
    output_format: String,
    width: u32,
    height: u32,
    output_dir: Option<String>,
    fps: u32,
    loop_animation: bool,
    lossy: bool,
    quality: u32,
    compression_level: u32,
    preset: String,
) -> Result<ConvertResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        convert_file_blocking(
            input_path,
            output_format,
            width,
            height,
            output_dir,
            fps,
            loop_animation,
            lossy,
            quality,
            compression_level,
            preset,
        )
    })
    .await
    .map_err(|error| format!("转换任务失败: {error}"))?
}

fn convert_file_blocking(
    input_path: String,
    output_format: String,
    width: u32,
    height: u32,
    output_dir: Option<String>,
    fps: u32,
    loop_animation: bool,
    lossy: bool,
    quality: u32,
    compression_level: u32,
    preset: String,
) -> Result<ConvertResult, String> {
    let output_format = normalize_output_format(&output_format)?;
    let input = PathBuf::from(input_path);
    if !input.is_file() {
        return Err("找不到这个输入文件".into());
    }
    let static_input = is_static_image_path(&input);
    validate_common_options(width, height, fps, static_input)?;

    match output_format {
        OutputFormat::Gif => {
            convert_to_gif_blocking(&input, width, height, output_dir, fps, static_input)
        }
        OutputFormat::Webp => convert_to_webp_blocking(
            &input,
            width,
            height,
            output_dir,
            fps,
            loop_animation,
            lossy,
            quality,
            compression_level,
            preset,
            static_input,
        ),
    }
}

fn convert_to_gif_blocking(
    input: &Path,
    width: u32,
    height: u32,
    output_dir: Option<String>,
    fps: u32,
    static_input: bool,
) -> Result<ConvertResult, String> {
    let output = next_output_path(input, output_dir.as_deref(), width, height, OutputFormat::Gif)?;
    let ffmpeg = ffmpeg_bin();

    if static_input {
        let filter = format!("scale={width}:{height}:flags=lanczos");
        let gif_result = Command::new(&ffmpeg)
            .args(["-hide_banner", "-n"])
            .arg("-i")
            .arg(input)
            .arg("-an")
            .arg("-vf")
            .arg(&filter)
            .arg("-frames:v")
            .arg("1")
            .arg(&output)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

        if !gif_result.status.success() {
            return Err(ffmpeg_error("导出 GIF 失败", &gif_result));
        }

        return output_result(output, "GIF");
    }

    let palette = palette_path();
    let palette_filter = format!("fps={fps},scale={width}:{height}:flags=lanczos,palettegen");
    let gif_filter =
        format!("[0:v]fps={fps},scale={width}:{height}:flags=lanczos[x];[x][1:v]paletteuse");

    let palette_result = Command::new(&ffmpeg)
        .args(["-hide_banner", "-y"])
        .arg("-i")
        .arg(input)
        .arg("-an")
        .arg("-vf")
        .arg(&palette_filter)
        .arg(&palette)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

    if !palette_result.status.success() {
        let _ = fs::remove_file(&palette);
        return Err(ffmpeg_error("生成调色板失败", &palette_result));
    }

    let gif_result = Command::new(&ffmpeg)
        .args(["-hide_banner", "-n"])
        .arg("-i")
        .arg(input)
        .arg("-i")
        .arg(&palette)
        .arg("-an")
        .arg("-filter_complex")
        .arg(&gif_filter)
        .arg(&output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

    let _ = fs::remove_file(&palette);

    if !gif_result.status.success() {
        return Err(ffmpeg_error("导出 GIF 失败", &gif_result));
    }

    output_result(output, "GIF")
}

fn convert_to_webp_blocking(
    input: &Path,
    width: u32,
    height: u32,
    output_dir: Option<String>,
    fps: u32,
    loop_animation: bool,
    lossy: bool,
    quality: u32,
    compression_level: u32,
    preset: String,
    static_input: bool,
) -> Result<ConvertResult, String> {
    if !(50..=100).contains(&quality) {
        return Err("有损质量需要在 50 到 100 之间".into());
    }
    if compression_level > 6 {
        return Err("压缩率需要在 0 到 6 之间".into());
    }
    let preset = normalize_webp_preset(&preset)?;

    let output = next_output_path(input, output_dir.as_deref(), width, height, OutputFormat::Webp)?;
    let ffmpeg = ffmpeg_bin();
    let filter = if static_input {
        format!("scale={width}:{height}:flags=lanczos")
    } else {
        format!("fps={fps},scale={width}:{height}:flags=lanczos")
    };
    let loop_count = if loop_animation { "0" } else { "1" };
    let lossless = if lossy { "0" } else { "1" };
    let mut command = Command::new(&ffmpeg);
    command
        .args(["-hide_banner", "-n"])
        .arg("-i")
        .arg(input)
        .arg("-an")
        .arg("-vf")
        .arg(&filter);

    if static_input {
        command.args(["-c:v", "libwebp"]).arg("-frames:v").arg("1");
    } else {
        command
            .args(["-c:v", "libwebp_anim"])
            .args(["-loop", loop_count]);
    }

    command
        .args(["-lossless", lossless])
        .arg("-compression_level")
        .arg(compression_level.to_string())
        .arg("-preset")
        .arg(preset);

    if lossy {
        command.arg("-q:v").arg(quality.to_string());
    }

    let webp_result = command
        .arg(&output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

    if !webp_result.status.success() {
        return Err(ffmpeg_error("导出 WebP 失败", &webp_result));
    }

    output_result(output, "WebP")
}

#[tauri::command]
fn reveal_in_finder(output_path: String) -> Result<(), String> {
    let path = PathBuf::from(output_path);
    if !path.is_file() {
        return Err("找不到刚生成的文件".into());
    }
    Command::new("open")
        .arg("-R")
        .arg(path)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法打开 Finder: {error}"))?;
    Ok(())
}

#[tauri::command]
fn media_info(input_path: String) -> Result<MediaInfo, String> {
    let input = PathBuf::from(input_path);
    if !input.is_file() {
        return Err("找不到这个输入文件".into());
    }

    let output = Command::new(ffprobe_bin())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate:format=duration",
            "-of",
            "json",
        ])
        .arg(&input)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffprobe: {error}"))?;

    if !output.status.success() {
        return Err(ffmpeg_error("读取媒体信息失败", &output));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("解析媒体信息失败: {error}"))?;
    let stream = json
        .get("streams")
        .and_then(|streams| streams.as_array())
        .and_then(|streams| streams.first())
        .ok_or("读取不到视频流信息")?;

    Ok(MediaInfo {
        width: stream
            .get("width")
            .and_then(|value| value.as_u64())
            .unwrap_or_default(),
        height: stream
            .get("height")
            .and_then(|value| value.as_u64())
            .unwrap_or_default(),
        fps: stream
            .get("r_frame_rate")
            .and_then(|value| value.as_str())
            .map(parse_rate)
            .unwrap_or_default(),
        duration: json
            .get("format")
            .and_then(|format| format.get("duration"))
            .and_then(|value| value.as_str())
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or_default(),
        is_static_image: is_static_image_path(&input),
    })
}

#[tauri::command]
fn desktop_dir() -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("找不到用户目录")?;
    let desktop = PathBuf::from(home).join("Desktop");
    if desktop.is_dir() {
        Ok(desktop.to_string_lossy().into_owned())
    } else {
        std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| format!("找不到默认保存目录: {error}"))
    }
}

fn validate_common_options(
    width: u32,
    height: u32,
    fps: u32,
    static_input: bool,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("宽高必须大于 0".into());
    }
    if !static_input && !(10..=30).contains(&fps) {
        return Err("FPS 需要在 10 到 30 之间".into());
    }
    Ok(())
}

fn is_static_image_path(input: &Path) -> bool {
    matches!(
        input.extension().and_then(|extension| extension.to_str()),
        Some(extension)
            if extension.eq_ignore_ascii_case("png")
                || extension.eq_ignore_ascii_case("jpg")
                || extension.eq_ignore_ascii_case("jpeg")
                || extension.eq_ignore_ascii_case("bmp")
                || extension.eq_ignore_ascii_case("tif")
                || extension.eq_ignore_ascii_case("tiff")
                || extension.eq_ignore_ascii_case("heic")
                || extension.eq_ignore_ascii_case("heif")
                || extension.eq_ignore_ascii_case("avif")
    )
}

fn output_result(output: PathBuf, label: &str) -> Result<ConvertResult, String> {
    let file_size = fs::metadata(&output)
        .map_err(|error| format!("读取 {label} 文件大小失败: {error}"))?
        .len();

    Ok(ConvertResult {
        output_path: output.to_string_lossy().into_owned(),
        file_size,
    })
}

fn next_output_path(
    input: &Path,
    output_dir: Option<&str>,
    width: u32,
    height: u32,
    output_format: OutputFormat,
) -> Result<PathBuf, String> {
    let directory = match output_dir.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path);
            fs::create_dir_all(&path).map_err(|error| format!("无法创建保存文件夹: {error}"))?;
            path
        }
        None => input.parent().ok_or("无法确定输出目录")?.to_path_buf(),
    };
    if !directory.is_dir() {
        return Err("保存文件夹不可用".into());
    }
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy())
        .unwrap_or_else(|| "output".into());
    let size = format!("{width}x{height}");
    let extension = output_extension(output_format);
    let label = output_label(output_format);

    for index in 0..1000 {
        let file_name = if index == 0 {
            format!("{stem}-{size}.{extension}")
        } else {
            format!("{stem}-{size}-{index}.{extension}")
        };
        let path = directory.join(file_name);
        if !path.exists() {
            return Ok(path);
        }
    }

    Err(format!("输出目录里同名 {label} 太多了"))
}

fn palette_path() -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("any-forge-{}-{now}.png", std::process::id()))
}

fn normalize_output_format(format: &str) -> Result<OutputFormat, String> {
    match format {
        "gif" => Ok(OutputFormat::Gif),
        "webp" => Ok(OutputFormat::Webp),
        _ => Err("输出格式只支持 gif/webp".into()),
    }
}

fn output_extension(format: OutputFormat) -> &'static str {
    match format {
        OutputFormat::Gif => "gif",
        OutputFormat::Webp => "webp",
    }
}

fn output_label(format: OutputFormat) -> &'static str {
    match format {
        OutputFormat::Gif => "GIF",
        OutputFormat::Webp => "WebP",
    }
}

fn normalize_webp_preset(preset: &str) -> Result<&'static str, String> {
    match preset {
        "picture" => Ok("picture"),
        "photo" => Ok("photo"),
        "icon" => Ok("icon"),
        _ => Err("WebP 预设只支持 picture/photo/icon".into()),
    }
}

fn ffmpeg_bin() -> OsString {
    if Command::new("ffmpeg")
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        return "ffmpeg".into();
    }

    for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if Path::new(path).is_file() {
            return path.into();
        }
    }

    "ffmpeg".into()
}

fn ffprobe_bin() -> OsString {
    if Command::new("ffprobe")
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        return "ffprobe".into();
    }

    for path in ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"] {
        if Path::new(path).is_file() {
            return path.into();
        }
    }

    "ffprobe".into()
}

fn parse_rate(rate: &str) -> f64 {
    let Some((numerator, denominator)) = rate.split_once('/') else {
        return rate.parse().unwrap_or_default();
    };
    let numerator = numerator.parse::<f64>().unwrap_or_default();
    let denominator = denominator.parse::<f64>().unwrap_or_default();
    if denominator == 0.0 {
        0.0
    } else {
        numerator / denominator
    }
}

fn ffmpeg_error(context: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        context.into()
    } else {
        format!("{context}: {stderr}")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            convert_file,
            desktop_dir,
            media_info,
            reveal_in_finder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn next_output_path_skips_existing_outputs() {
        let directory = test_dir("any-forge-test");
        fs::create_dir_all(&directory).unwrap();
        let input = directory.join("avatar.mov");
        fs::write(&input, b"").unwrap();
        fs::write(directory.join("avatar-144x144.webp"), b"").unwrap();

        assert_eq!(
            next_output_path(&input, None, 144, 144, OutputFormat::Webp)
                .unwrap()
                .file_name()
                .unwrap(),
            "avatar-144x144-1.webp"
        );
        assert_eq!(
            next_output_path(&input, None, 144, 144, OutputFormat::Gif)
                .unwrap()
                .file_name()
                .unwrap(),
            "avatar-144x144.gif"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn next_output_path_uses_configured_directory() {
        let root = test_dir("any-forge-test");
        let input_dir = root.join("input");
        let output_dir = root.join("output");
        fs::create_dir_all(&input_dir).unwrap();
        let input = input_dir.join("avatar.png");
        fs::write(&input, b"").unwrap();

        assert_eq!(
            next_output_path(
                &input,
                Some(output_dir.to_str().unwrap()),
                144,
                144,
                OutputFormat::Gif
            )
            .unwrap()
            .parent()
            .unwrap(),
            output_dir
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_output_format_allows_supported_values() {
        assert_eq!(normalize_output_format("gif").unwrap(), OutputFormat::Gif);
        assert_eq!(normalize_output_format("webp").unwrap(), OutputFormat::Webp);
        assert!(normalize_output_format("mp4").is_err());
    }

    #[test]
    fn normalize_webp_preset_allows_ui_values() {
        assert_eq!(normalize_webp_preset("picture").unwrap(), "picture");
        assert_eq!(normalize_webp_preset("photo").unwrap(), "photo");
        assert_eq!(normalize_webp_preset("icon").unwrap(), "icon");
        assert!(normalize_webp_preset("drawing").is_err());
    }

    #[test]
    fn static_image_detection_handles_common_extensions() {
        assert!(is_static_image_path(Path::new("avatar.png")));
        assert!(is_static_image_path(Path::new("avatar.JPEG")));
        assert!(is_static_image_path(Path::new("avatar.tiff")));
        assert!(!is_static_image_path(Path::new("avatar.gif")));
        assert!(!is_static_image_path(Path::new("avatar.mp4")));
    }

    #[test]
    fn static_inputs_do_not_require_animation_fps() {
        assert!(validate_common_options(144, 144, 0, true).is_ok());
        assert!(validate_common_options(144, 144, 0, false).is_err());
    }

    #[test]
    fn parse_rate_handles_fractional_fps() {
        assert_eq!(parse_rate("30/1"), 30.0);
        assert!((parse_rate("30000/1001") - 29.970).abs() < 0.01);
        assert_eq!(parse_rate("0/0"), 0.0);
    }
}
