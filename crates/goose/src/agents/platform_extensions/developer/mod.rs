pub mod edit;
pub mod image;
pub mod shell;
mod shell_output_streaming;
mod shell_process;
pub mod tree;

use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::ToolCallContext;
use anyhow::Result;
use async_trait::async_trait;
use edit::{EditTools, FileEditParams, FileWriteParams};
use image::{ImageReadParams, ImageTool};
use indoc::indoc;
use rmcp::model::{
    Annotations, CallToolResult, ContentBlock, Implementation, InitializeResult, JsonObject,
    ListToolsResult, ServerCapabilities, TextContent, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde_json::Value;
use shell::{shell_display_name, ShellOutput, ShellParams, ShellTool};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tree::{TreeParams, TreeTool};

pub static EXTENSION_NAME: &str = "developer";

fn visible_text(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text(
        TextContent::new(text).with_annotations(Annotations::default().with_priority(0.0)),
    )
}

pub struct DeveloperClient {
    info: InitializeResult,
    shell_tool: Arc<ShellTool>,
    edit_tools: Arc<EditTools>,
    tree_tool: Arc<TreeTool>,
    image_tool: Arc<ImageTool>,
}

fn developer_instructions() -> String {
    if cfg!(windows) {
        windows_developer_instructions(&shell_display_name())
    } else {
        indoc! {"
            Use the developer extension to build software and operate a terminal.

            Make sure to use the tools *efficiently* - reading all the content you need in as few
            iterations as possible and then making the requested edits or running commands. You are
            responsible for managing your context window, and to minimize unnecessary turns which
            cost the user money.

            For editing software, prefer the flow of using tree to understand the codebase structure
            and file sizes. When you need to search, prefer rg which correctly respects gitignored
            content. Then use cat or sed to gather the context you need, always reading before editing.
            Use write and edit to efficiently make changes. Test and verify as appropriate.

            When running Python scripts or commands, always use `python3` instead of `python`.
        "}
        .to_string()
    }
}

/// The Windows half of the instructions, phrased for the shell the `shell` tool
/// will actually run.
///
/// This used to hard-code cmd.exe's `findstr` and `type`, so with
/// GOOSE_SHELL=powershell the model was told to reach for two commands that do not
/// exist there. Only those two phrases vary; the cmd wording is unchanged.
fn windows_developer_instructions(shell: &str) -> String {
    let (search_hint, read_hint) = match shell {
        "pwsh" | "powershell" => ("prefer Select-String (via shell)", "use Get-Content"),
        _ => (
            "prefer findstr or Select-String (via shell)",
            "use type or Get-Content",
        ),
    };
    indoc! {"
        Use the developer extension to build software and operate a terminal.

        Make sure to use the tools *efficiently* - reading all the content you need in as few
        iterations as possible and then making the requested edits or running commands. You are
        responsible for managing your context window, and to minimize unnecessary turns which
        cost the user money.

        For editing software, prefer the flow of using tree to understand the codebase structure
        and file sizes. When you need to search, {search_hint}.
        Then {read_hint} to gather the context you need, always reading before
        editing. Use write and edit to efficiently make changes. Test and verify as appropriate.
    "}
    .replace("{search_hint}", search_hint)
    .replace("{read_hint}", read_hint)
}

/// Build the `shell` tool description for the shell dialect that will actually run.
///
/// Models on Windows keep emitting cmd.exe syntax (`& del`, `dir /b`, `findstr`,
/// `2>NUL`) even when GOOSE_SHELL points at PowerShell, so each supported shell gets
/// an explicit note on how to chain commands and which cmd-isms to avoid. Any other
/// shell (bash, sh, ...) keeps the bare description.
pub(crate) fn shell_tool_description(shell: &str) -> String {
    let syntax_note = match shell {
        "cmd" => {
            " Commands must be on a single line — cmd.exe silently truncates at the \
             first newline. Use `&` to chain (e.g. `echo a & echo b`) or set \
             GOOSE_SHELL=powershell for multi-line support."
        }
        "pwsh" => {
            " Commands run under PowerShell 7. Chain commands with `;` (`&&` and `||` also \
             work). Do not write cmd.exe syntax: no `dir /b`, `findstr`, `type`, `more`, \
             `del /f`, `2>NUL` or `%VAR%`. Use `Get-ChildItem -Name`, `Select-String`, \
             `Get-Content`, `Remove-Item`, `2>$null`, `$env:VAR`. A lone `&` is the call \
             operator, not a separator. The command already runs in PowerShell: never wrap \
             it in `powershell -Command` or `pwsh -Command`, because the outer shell expands \
             `$variables` inside the quotes before the inner one runs."
        }
        "powershell" => {
            " Commands run under Windows PowerShell 5.1. Chain commands with `;` only \
             (`&&` and `||` do not exist in 5.1). Do not write cmd.exe syntax: no \
             `dir /b`, `findstr`, `type`, `more`, `del /f`, `2>NUL` or `%VAR%`. Use \
             `Get-ChildItem -Name`, `Select-String`, `Get-Content`, `Remove-Item`, \
             `2>$null`, `$env:VAR`. A lone `&` is the call operator, not a separator. \
             The command already runs in PowerShell: never wrap it in `powershell -Command` \
             or `pwsh -Command`, because the outer shell expands `$variables` inside the \
             quotes before the inner one runs."
        }
        _ => "",
    };
    format!(
        "Execute a shell command in the current dir. Commands run under `{shell}` \
         (set GOOSE_SHELL to override) - write command strings in that shell's \
         syntax.{syntax_note} Returns an object with stdout and stderr as separate \
         fields. The output of each stream is limited to up to 2000 lines, and \
         longer outputs will be saved to a temporary file.",
    )
}

impl DeveloperClient {
    pub fn new() -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(EXTENSION_NAME, "1.0.0").with_title("Developer"))
            .with_instructions(developer_instructions());

        Ok(Self {
            info,
            shell_tool: Arc::new(ShellTool::new()?),
            edit_tools: Arc::new(EditTools::new()),
            tree_tool: Arc::new(TreeTool::new()),
            image_tool: Arc::new(ImageTool::new()),
        })
    }

    fn schema<T: JsonSchema>() -> JsonObject {
        serde_json::to_value(schema_for!(T))
            .expect("schema serialization should succeed")
            .as_object()
            .expect("schema should serialize to an object")
            .clone()
    }

    pub fn parse_args<T: serde::de::DeserializeOwned>(
        arguments: Option<JsonObject>,
    ) -> Result<T, String> {
        let value = arguments
            .map(Value::Object)
            .ok_or_else(|| "Missing arguments".to_string())?;
        serde_json::from_value(value).map_err(|e| format!("Failed to parse arguments: {e}"))
    }

    pub(crate) fn get_tools() -> Vec<Tool> {
        vec![
            Tool::new(
                "write".to_string(),
                "Create a new file or overwrite an existing file. Creates parent directories if needed.".to_string(),
                Self::schema::<FileWriteParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Write".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                "edit".to_string(),
                "Edit a file by finding and replacing text. The before text must match exactly and uniquely. Use empty after text to delete.".to_string(),
                Self::schema::<FileEditParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Edit".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            {
                let description = shell_tool_description(&shell_display_name());
                Tool::new("shell".to_string(), description, Self::schema::<ShellParams>())
            }
            .with_output_schema::<ShellOutput>()
            .annotate(ToolAnnotations::from_raw(
                Some("Shell".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
            )),
            Tool::new(
                "tree".to_string(),
                "List a directory tree with line counts. Traversal respects .gitignore rules.".to_string(),
                Self::schema::<TreeParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Tree".to_string()),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
            )),
            Tool::new(
                "read_image".to_string(),
                "Read an image from a local file path or http(s) URL and return it as image content for the model to inspect. Supports png, jpeg, gif, and webp.".to_string(),
                Self::schema::<ImageReadParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Read Image".to_string()),
                Some(false),
                Some(false),
                Some(true),
                Some(true),
            )),
        ]
    }
}

#[async_trait]
impl McpClientTrait for DeveloperClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::get_tools(),
            next_cursor: None,
            meta: None,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        cancel_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let working_dir = ctx.working_dir.as_deref();
        match name {
            "shell" => match Self::parse_args::<ShellParams>(arguments) {
                Ok(params) => Ok(self
                    .shell_tool
                    .shell_with_cwd_and_emitter(
                        params,
                        working_dir,
                        Some(&ctx.session_id),
                        ctx.notification_emitter().cloned(),
                        cancel_token,
                    )
                    .await),
                Err(error) => Ok(ShellTool::error_result(&format!("Error: {error}"), None)),
            },
            "write" => match Self::parse_args::<FileWriteParams>(arguments) {
                Ok(params) => Ok(self.edit_tools.file_write_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![visible_text(format!(
                    "Error: {error}"
                ))])),
            },
            "edit" => match Self::parse_args::<FileEditParams>(arguments) {
                Ok(params) => Ok(self.edit_tools.file_edit_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![visible_text(format!(
                    "Error: {error}"
                ))])),
            },
            "tree" => match Self::parse_args::<TreeParams>(arguments) {
                Ok(params) => Ok(self.tree_tool.tree_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![visible_text(format!(
                    "Error: {error}"
                ))])),
            },
            "read_image" => match Self::parse_args::<ImageReadParams>(arguments) {
                Ok(params) => Ok(self
                    .image_tool
                    .image_read_with_cwd(params, working_dir)
                    .await),
                Err(error) => Ok(CallToolResult::error(vec![visible_text(format!(
                    "Error: {error}"
                ))])),
            },
            _ => Ok(CallToolResult::error(vec![visible_text(format!(
                "Error: Unknown tool: {name}"
            ))])),
        }
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ContentBlock;
    use rmcp::object;
    use std::fs;

    #[test]
    fn developer_tools_are_flat() {
        let names: Vec<String> = DeveloperClient::get_tools()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();

        assert_eq!(names, vec!["write", "edit", "shell", "tree", "read_image"]);
    }

    #[test]
    fn read_image_annotations_reflect_network_access() {
        let read_image = DeveloperClient::get_tools()
            .into_iter()
            .find(|tool| tool.name == "read_image")
            .unwrap();
        let annotations = read_image.annotations.unwrap();

        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.open_world_hint, Some(true));
    }

    fn first_text(result: &CallToolResult) -> &str {
        match &result.content[0] {
            ContentBlock::Text(text) => &text.text,
            _ => panic!("expected text content"),
        }
    }

    #[tokio::test]
    async fn developer_client_uses_working_dir_for_file_tools() {
        let temp = tempfile::tempdir().unwrap();
        let client = DeveloperClient::new().unwrap();
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();

        let ctx = ToolCallContext::new("session".to_owned(), Some(cwd.clone()), None);
        let write = client
            .call_tool(
                &ctx,
                "write",
                Some(object!({
                    "path": "notes.txt",
                    "content": "first line"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(write.is_error, Some(false));
        assert_eq!(
            fs::read_to_string(cwd.join("notes.txt")).unwrap(),
            "first line"
        );

        let edit = client
            .call_tool(
                &ctx,
                "edit",
                Some(object!({
                    "path": "notes.txt",
                    "before": "first",
                    "after": "updated"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(edit.is_error, Some(false));
        assert_eq!(
            fs::read_to_string(cwd.join("notes.txt")).unwrap(),
            "updated line"
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn developer_client_passes_session_id_to_shell_tool() {
        let client = DeveloperClient::new().unwrap();
        let ctx = ToolCallContext::new("session-789".to_owned(), None, None);

        let result = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({
                    "command": "printenv AGENT_SESSION_ID"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(false));
        assert_eq!(first_text(&result), "session-789");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn developer_client_uses_working_dir_for_shell_tool() {
        let temp = tempfile::tempdir().unwrap();
        let client = DeveloperClient::new().unwrap();
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();

        let ctx = ToolCallContext::new("session".to_owned(), Some(cwd.clone()), None);
        let result = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({
                    "command": "pwd"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(false));
        let observed = std::fs::canonicalize(first_text(&result)).unwrap();
        let expected = std::fs::canonicalize(&cwd).unwrap();
        assert_eq!(observed, expected);
    }

    const SHELL_DESC_HEAD: &str = "Execute a shell command in the current dir. Commands run under ";
    const SHELL_DESC_TAIL: &str = "Returns an object with stdout and stderr as separate fields. \
        The output of each stream is limited to up to 2000 lines, and longer outputs will be \
        saved to a temporary file.";

    #[test]
    fn shell_description_pwsh_uses_powershell_syntax() {
        let description = shell_tool_description("pwsh");

        assert!(
            description.contains("`pwsh`"),
            "names the shell: {description}"
        );
        assert!(
            description.contains("PowerShell 7"),
            "names the shell: {description}"
        );
        assert!(
            description.contains("Chain commands with `;`"),
            "spells out chaining: {description}"
        );
        assert!(
            description.contains("Do not write cmd.exe syntax"),
            "bans cmd syntax: {description}"
        );
        assert!(
            description.contains("2>$null"),
            "gives the PS redirect: {description}"
        );
        assert!(
            description.contains("`&&` and `||` also work"),
            "PowerShell 7 has chain operators: {description}"
        );

        for cmdism in [
            "dir /b", "findstr", "type", "more", "del /f", "2>NUL", "%VAR%",
        ] {
            assert!(
                description.contains(cmdism),
                "calls out the cmd-ism {cmdism}: {description}"
            );
        }
        for alternative in [
            "Get-ChildItem -Name",
            "Select-String",
            "Get-Content",
            "Remove-Item",
            "$env:VAR",
        ] {
            assert!(
                description.contains(alternative),
                "suggests the PowerShell equivalent {alternative}: {description}"
            );
        }
    }

    #[test]
    fn shell_description_powershell_5_1_rejects_chain_operators() {
        let description = shell_tool_description("powershell");

        assert!(
            description.contains("`powershell`"),
            "names the shell: {description}"
        );
        assert!(
            description.contains("Windows PowerShell 5.1"),
            "names the shell: {description}"
        );
        assert!(
            description.contains("Chain commands with `;`"),
            "spells out chaining: {description}"
        );
        assert!(
            description.contains("Do not write cmd.exe syntax"),
            "bans cmd syntax: {description}"
        );
        assert!(
            description.contains("2>$null"),
            "gives the PS redirect: {description}"
        );
        assert!(
            description.contains("`&&` and `||` do not exist in 5.1"),
            "5.1 has no chain operators: {description}"
        );
        assert!(
            !description.contains("`&&` and `||` also work"),
            "5.1 must not advertise chain operators: {description}"
        );
    }

    #[test]
    fn shell_description_powershell_forbids_nesting_a_second_shell() {
        for shell in ["pwsh", "powershell"] {
            let description = shell_tool_description(shell);
            assert!(
                description.contains("never wrap it in `powershell -Command` or `pwsh -Command`"),
                "{shell} must forbid nested shells: {description}"
            );
            assert!(
                description.contains("expands `$variables` inside the quotes"),
                "{shell} must say why: {description}"
            );
        }
        assert!(!shell_tool_description("cmd").contains("never wrap it"));
        assert!(!shell_tool_description("bash").contains("never wrap it"));
    }

    #[test]
    fn shell_description_cmd_keeps_the_single_line_warning() {
        let description = shell_tool_description("cmd");

        assert!(
            description.contains("`cmd`"),
            "names the shell: {description}"
        );
        assert!(
            description.starts_with(&format!("{SHELL_DESC_HEAD}`cmd` ")),
            "keeps the leading text for cmd: {description}"
        );
        assert!(
            description.ends_with(SHELL_DESC_TAIL),
            "keeps the output-limit text for cmd: {description}"
        );
        assert!(
            description.contains(
                "Commands must be on a single line \u{2014} cmd.exe silently truncates at the first newline"
            ),
            "cmd keeps its single-line warning: {description}"
        );
        assert!(
            description.contains(
                "Use `&` to chain (e.g. `echo a & echo b`) or set GOOSE_SHELL=powershell for multi-line support."
            ),
            "cmd keeps its chaining hint: {description}"
        );
        assert!(
            !description.contains("PowerShell 7"),
            "cmd must not pick up the pwsh note: {description}"
        );
    }

    #[test]
    fn shell_description_other_shells_stay_bare() {
        for shell in ["bash", "sh", "zsh", "fish"] {
            let description = shell_tool_description(shell);

            assert!(
                description.starts_with(&format!("{SHELL_DESC_HEAD}`{shell}` ")),
                "keeps the leading text for {shell}: {description}"
            );
            assert!(
                description.ends_with(SHELL_DESC_TAIL),
                "keeps the output-limit text for {shell}: {description}"
            );
            assert!(
                !description.contains("PowerShell"),
                "{shell} must not get PowerShell text: {description}"
            );
            assert!(
                !description.contains("cmd.exe"),
                "{shell} must not get cmd.exe text: {description}"
            );
            assert_eq!(
                description,
                format!(
                    "{SHELL_DESC_HEAD}`{shell}` (set GOOSE_SHELL to override) - write command strings in that shell's syntax. {SHELL_DESC_TAIL}"
                ),
                "unrecognised shells must keep the exact legacy description"
            );
        }
    }

    #[test]
    fn windows_instructions_match_the_configured_shell() {
        let cmd = windows_developer_instructions("cmd");
        assert!(
            cmd.contains("When you need to search, prefer findstr or Select-String (via shell)."),
            "cmd must keep findstr: {cmd}"
        );
        assert!(
            cmd.contains("Then use type or Get-Content to gather the context you need"),
            "cmd must keep type: {cmd}"
        );

        for shell in ["pwsh", "powershell"] {
            let instructions = windows_developer_instructions(shell);

            assert!(
                instructions.contains("When you need to search, prefer Select-String (via shell)."),
                "{shell} must recommend Select-String: {instructions}"
            );
            assert!(
                instructions.contains("Then use Get-Content to gather the context you need"),
                "{shell} must recommend Get-Content: {instructions}"
            );
            assert!(
                !instructions.contains("findstr"),
                "{shell} must not recommend findstr: {instructions}"
            );
            assert!(
                !instructions.contains("type or"),
                "{shell} must not recommend the cmd type builtin: {instructions}"
            );
            assert!(
                instructions.contains("prefer the flow of using tree"),
                "shell-independent guidance must survive for {shell}: {instructions}"
            );
        }
    }
}
