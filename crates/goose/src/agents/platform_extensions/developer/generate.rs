//! `generate_image`: makes a picture through the local model server's OpenAI-style images endpoint
//! (Strata's `POST /v1/images/generations`), saves the PNG next to the work and shows it in the chat.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use rmcp::model::{Annotations, CallToolResult, ContentBlock, TextContent};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::edit::resolve_path;

/// Config key (or environment variable) for the images endpoint.
pub const IMAGE_ENDPOINT_KEY: &str = "GOOSE_IMAGE_ENDPOINT";
/// Config key (secret, config value or environment variable) for the image server's API key, sent as a Bearer token.
pub const IMAGE_API_KEY_KEY: &str = "GOOSE_IMAGE_API_KEY";
const DEFAULT_IMAGE_ENDPOINT: &str = "http://127.0.0.1:8080/v1/images/generations";
/// Config key (or environment variable) for the image model switcher (StrataTray's control port).
/// Set it to "off" to never switch.
pub const IMAGE_SWITCH_URL_KEY: &str = "GOOSE_IMAGE_SWITCH_URL";
const DEFAULT_IMAGE_SWITCH_URL: &str = "http://127.0.0.1:8081/image";
/// A switch restarts the server, which can take minutes.
const SWITCH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A full-precision model at many steps can take minutes; Strata's own job limit is an hour.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DEFAULT_DIR: &str = "generated-images";

fn visible_text(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text(
        TextContent::new(text).with_annotations(Annotations::default().with_priority(0.0)),
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImageGenerateParams {
    /// What the image should show. Be specific: subject, setting, style, lighting, composition.
    pub prompt: String,
    /// "WIDTHxHEIGHT", each side a multiple of 32 from 256 to 2048. Default 1024x1024.
    #[serde(default)]
    pub size: Option<String>,
    /// Seed for a repeatable image. Default: random (the result says which was used).
    #[serde(default)]
    pub seed: Option<u64>,
    /// Image model to draw with, e.g. "qwen-image-2.1-turbo-F16" or "qwen-image-2.1-turbo-Q8_0".
    /// Leave unset to use the one already in use. Switching restarts the model server.
    #[serde(default)]
    pub model: Option<String>,
    /// Denoising steps. Leave unset for the server's default.
    #[serde(default)]
    pub steps: Option<u32>,
    /// Where to save the PNG, relative to the working directory.
    /// Default: generated-images/<time>-<seed>.png
    #[serde(default)]
    pub save_as: Option<String>,
}

pub struct GenerateTool;

impl GenerateTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn generate_with_cwd(
        &self,
        params: ImageGenerateParams,
        working_dir: Option<&Path>,
        cancel_token: CancellationToken,
    ) -> CallToolResult {
        let endpoint = crate::config::Config::global()
            .get_param::<String>(IMAGE_ENDPOINT_KEY)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_IMAGE_ENDPOINT.to_string());
        let config = crate::config::Config::global();
        let api_key = config
            .get_secret::<String>(IMAGE_API_KEY_KEY)
            .or_else(|_| config.get_param::<String>(IMAGE_API_KEY_KEY))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let switch_url = image_switch_url();
        let work = async {
            if let Some(model) = params
                .model
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
            {
                switch_image_model(&switch_url, model, false).await?;
            }
            generate(&endpoint, api_key.as_deref(), &params, working_dir).await
        };
        tokio::select! {
            result = work => match result {
                Ok(done) => done.into_result(&params.prompt),
                Err(error) => CallToolResult::error(vec![visible_text(format!("Error: {error}"))]),
            },
            () = cancel_token.cancelled() => {
                CallToolResult::error(vec![visible_text("Error: image generation was cancelled")])
            }
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImageModelParams {
    /// The image model to switch to. Leave unset to list the models and see which one is in use.
    #[serde(default)]
    pub model: Option<String>,
}

/// `image_model`: lists the local image models or switches to one (through the same switcher as
/// the chat bar's image picker and the tray's Image menu).
pub async fn image_model_tool(params: ImageModelParams) -> CallToolResult {
    let url = image_switch_url();
    let wanted = params
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    if let Some(model) = wanted {
        if let Err(error) = switch_image_model(&url, model, true).await {
            return CallToolResult::error(vec![visible_text(format!("Error: {error}"))]);
        }
    }
    match list_image_models(&url).await {
        Ok(list) => {
            let current = list.current.unwrap_or_else(|| "none".to_string());
            let lead = if wanted.is_some() {
                format!("Switched. The image model in use is now {current}.")
            } else {
                format!("The image model in use is {current}.")
            };
            CallToolResult::success(vec![visible_text(format!(
                "{lead} Available: {}.",
                list.models.join(", ")
            ))])
        }
        Err(error) => match wanted {
            Some(model) => CallToolResult::success(vec![visible_text(format!(
                "Switched to {model}. (Could not list the models afterwards: {error})"
            ))]),
            None => CallToolResult::error(vec![visible_text(format!("Error: {error}"))]),
        },
    }
}

impl Default for GenerateTool {
    fn default() -> Self {
        Self::new()
    }
}

struct Generated {
    png_base64: String,
    saved_to: PathBuf,
    seed: Option<u64>,
    seconds: Option<f64>,
    size: String,
}

impl Generated {
    fn into_result(self, prompt: &str) -> CallToolResult {
        let seed = self.seed.map(|s| format!(", seed {s}")).unwrap_or_default();
        let secs = self
            .seconds
            .map(|s| format!(" in {s:.0} s"))
            .unwrap_or_default();
        let mut result = CallToolResult::success(vec![
            visible_text(format!(
                "Generated a {} image{secs}{seed}. Saved to {}.",
                self.size,
                self.saved_to.display()
            )),
            ContentBlock::image(self.png_base64, "image/png".to_string()),
        ]);
        result.structured_content = Some(json!({
            "prompt": prompt,
            "path": self.saved_to.to_string_lossy(),
            "size": self.size,
            "seed": self.seed,
            "seconds": self.seconds,
        }));
        result
    }
}

/// The image model switcher's URL (StrataTray's control port unless configured; "off" = none).
pub fn image_switch_url() -> String {
    crate::config::Config::global()
        .get_param::<String>(IMAGE_SWITCH_URL_KEY)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_IMAGE_SWITCH_URL.to_string())
}

fn switcher_off(url: &str) -> bool {
    url.eq_ignore_ascii_case("off")
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ImageModelList {
    pub current: Option<String>,
    pub models: Vec<String>,
}

/// The image models the switcher offers and the one in use.
pub async fn list_image_models(url: &str) -> Result<ImageModelList, String> {
    if switcher_off(url) {
        return Err(format!(
            "the image model switcher is off ({IMAGE_SWITCH_URL_KEY})"
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("failed to create HTTP client: {error}"))?;
    let response = client.get(url).send().await.map_err(|error| {
        format!(
            "the image model switcher at {url} did not answer (is StrataTray running?): {error}"
        )
    })?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("the image model switcher at {url} sent no JSON: {error}"))?;
    if !status.is_success() {
        let message = body["error"].as_str().unwrap_or("no reason given");
        return Err(format!(
            "the image model switcher at {url} answered {status}: {message}"
        ));
    }
    Ok(ImageModelList {
        current: body["model"].as_str().map(str::to_string),
        models: body["models"]
            .as_array()
            .map(|all| {
                all.iter()
                    .filter_map(|m| m.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Asks the switcher to put `model` on the image server. One that refuses is always an error, because
/// the picture would otherwise come from another model without saying so. One that does not answer is
/// an error only when `strict` (an explicit switch); before a drawing the server keeps what it has.
pub async fn switch_image_model(url: &str, model: &str, strict: bool) -> Result<(), String> {
    if model.is_empty() {
        return Err("no image model named".to_string());
    }
    if switcher_off(url) {
        return if strict {
            Err(format!(
                "the image model switcher is off ({IMAGE_SWITCH_URL_KEY})"
            ))
        } else {
            Ok(())
        };
    }
    let client = reqwest::Client::builder()
        .timeout(SWITCH_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create HTTP client: {error}"))?;
    let response = match client
        .post(url)
        .json(&json!({ "model": model }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if strict => {
            return Err(format!(
                "the image model switcher at {url} did not answer (is StrataTray running?): {error}"
            ));
        }
        Err(error) => {
            tracing::debug!("image model switcher at {url} did not answer ({error}); drawing with the current model");
            return Ok(());
        }
    };
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or(body);
    Err(format!(
        "could not switch the image model to '{model}': the switcher at {url} answered {status}: {message}"
    ))
}

async fn generate(
    endpoint: &str,
    api_key: Option<&str>,
    params: &ImageGenerateParams,
    working_dir: Option<&Path>,
) -> Result<Generated, String> {
    if params.prompt.trim().is_empty() {
        return Err("prompt cannot be empty".to_string());
    }
    let size = params
        .size
        .clone()
        .unwrap_or_else(|| "1024x1024".to_string());

    let mut body = json!({
        "prompt": params.prompt,
        "n": 1,
        "size": size,
        "response_format": "b64_json",
    });
    if let Some(seed) = params.seed {
        body["seed"] = json!(seed);
    }
    if let Some(steps) = params.steps {
        body["steps"] = json!(steps);
    }

    let client = reqwest::Client::builder()
        .timeout(GENERATE_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create HTTP client: {error}"))?;
    let mut request = client.post(endpoint).json(&body);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("could not reach the image server at {endpoint}: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("failed to read the image server's answer: {error}"))?;
    let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let message = answer["error"]["message"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| text.chars().take(500).collect());
        return Err(format!("the image server answered {status}: {message}"));
    }

    let first = &answer["data"][0];
    let png_base64 = first["b64_json"]
        .as_str()
        .ok_or_else(|| "the image server's answer has no data[0].b64_json".to_string())?
        .to_string();
    let png = base64::prelude::BASE64_STANDARD
        .decode(&png_base64)
        .map_err(|error| format!("the image server sent invalid base64: {error}"))?;
    let seed = first["seed"].as_u64().or(params.seed);
    let seconds = answer["strata"]["seconds"].as_f64();

    let saved_to = match &params.save_as {
        Some(path) if !path.trim().is_empty() => resolve_path(path, working_dir),
        _ => {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let name = match seed {
                Some(seed) => format!("{stamp}-{seed}.png"),
                None => format!("{stamp}.png"),
            };
            resolve_path(&format!("{DEFAULT_DIR}/{name}"), working_dir)
        }
    };
    if let Some(parent) = saved_to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    std::fs::write(&saved_to, &png)
        .map_err(|error| format!("could not save {}: {error}", saved_to.display()))?;

    Ok(Generated {
        png_base64,
        saved_to,
        seed,
        seconds,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // A 1x1 PNG.
    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn params(save_as: Option<&str>) -> ImageGenerateParams {
        ImageGenerateParams {
            prompt: "a red fox in snow".to_string(),
            size: Some("512x512".to_string()),
            seed: Some(42),
            steps: Some(30),
            model: None,
            save_as: save_as.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn saves_the_png_and_reports_seed_and_time() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .and(header("authorization", "Bearer 345!2"))
            .and(body_partial_json(json!({
                "prompt": "a red fox in snow",
                "size": "512x512",
                "seed": 42,
                "steps": 30,
                "response_format": "b64_json",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "created": 1,
                "data": [{"b64_json": PNG_B64, "seed": 42}],
                "strata": {"seconds": 41.6, "steps": 30},
            })))
            .expect(1)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();

        let done = generate(
            &format!("{}/v1/images/generations", server.uri()),
            Some("345!2"),
            &params(Some("art/fox.png")),
            Some(dir.path()),
        )
        .await
        .unwrap();

        assert_eq!(done.saved_to, dir.path().join("art/fox.png"));
        assert_eq!(
            std::fs::read(&done.saved_to).unwrap(),
            base64::prelude::BASE64_STANDARD.decode(PNG_B64).unwrap()
        );
        let result = done.into_result("a red fox in snow");
        assert_eq!(result.is_error, Some(false));
        let text = result.content[0].as_text().unwrap().text.clone();
        assert!(text.contains("512x512 image in 42 s, seed 42"), "{text}");
        assert!(result.content[1].as_image().is_some());
    }

    #[tokio::test]
    async fn default_location_is_generated_images_with_the_seed_in_the_name() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{"b64_json": PNG_B64, "seed": 7}],
            })))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();

        let done = generate(&server.uri(), None, &params(None), Some(dir.path()))
            .await
            .unwrap();

        assert_eq!(
            done.saved_to.parent().unwrap(),
            dir.path().join(DEFAULT_DIR)
        );
        let name = done.saved_to.file_name().unwrap().to_string_lossy();
        assert!(name.ends_with("-7.png"), "{name}");
    }

    #[tokio::test]
    async fn the_servers_own_error_message_comes_through() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": {"message": "size 500x500: each side a multiple of 32 from 256 to 2048"}
            })))
            .mount(&server)
            .await;

        let error = generate(&server.uri(), None, &params(None), None)
            .await
            .err()
            .unwrap();

        assert!(error.contains("400"), "{error}");
        assert!(error.contains("each side a multiple of 32"), "{error}");
    }

    #[tokio::test]
    async fn the_switcher_is_asked_for_the_model() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/image"))
            .and(body_partial_json(
                json!({"model": "qwen-image-2.1-turbo-Q8_0"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"switched": true})))
            .expect(1)
            .mount(&server)
            .await;
        switch_image_model(
            &format!("{}/image", server.uri()),
            "qwen-image-2.1-turbo-Q8_0",
            false,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_refused_switch_is_an_error_with_the_switchers_reason() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": "no image model \"x\"; there are: qwen-image-2.1-turbo-F16, qwen-image-2.1-turbo-Q8_0"
            })))
            .mount(&server)
            .await;
        let error = switch_image_model(&format!("{}/image", server.uri()), "x", false)
            .await
            .err()
            .unwrap();
        assert!(error.contains("409"), "{error}");
        assert!(
            error.contains("there are: qwen-image-2.1-turbo-F16"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_silent_switcher_is_not_an_error() {
        switch_image_model("http://127.0.0.1:9/image", "anything", false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn an_explicit_switch_says_when_the_switcher_is_not_there() {
        let error = switch_image_model("http://127.0.0.1:9/image", "anything", true)
            .await
            .err()
            .unwrap();
        assert!(error.contains("did not answer"), "{error}");
    }

    #[tokio::test]
    async fn the_list_comes_from_the_switcher() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/image"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "qwen-image-2.1-turbo-F16",
                "models": ["qwen-image-2.1-turbo-F16", "qwen-image-2.1-turbo-Q8_0"],
            })))
            .mount(&server)
            .await;
        let list = list_image_models(&format!("{}/image", server.uri()))
            .await
            .unwrap();
        assert_eq!(list.current.as_deref(), Some("qwen-image-2.1-turbo-F16"));
        assert_eq!(list.models.len(), 2);
    }

    #[tokio::test]
    async fn an_empty_prompt_never_reaches_the_server() {
        let mut p = params(None);
        p.prompt = "  ".to_string();
        let error = generate("http://127.0.0.1:9/never", None, &p, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error, "prompt cannot be empty");
    }
}
