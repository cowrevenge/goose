use std::fs;
use std::path::Path;

use rmcp::model::{Annotations, CallToolResult, ContentBlock, TextContent};
use schemars::JsonSchema;
use serde::Deserialize;

use super::edit::resolve_path;

/// Lines returned when no `limit` is given.
const DEFAULT_LIMIT: usize = 2000;
/// Cap on the text returned in one call, whatever the limit, so one read cannot flood the context.
const MAX_BYTES: usize = 50_000;
/// A NUL in the first bytes means a binary file, which this tool does not show.
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FileReadParams {
    /// File to read, absolute or relative to the working directory.
    pub path: String,
    /// First line to return, counting from 1. Defaults to 1.
    #[serde(default)]
    pub offset: Option<usize>,
    /// Number of lines to return. Defaults to 2000.
    #[serde(default)]
    pub limit: Option<usize>,
}

pub struct ReadTool;

fn visible_text(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text(
        TextContent::new(text).with_annotations(Annotations::default().with_priority(0.0)),
    )
}

impl ReadTool {
    pub fn new() -> Self {
        Self
    }

    /// Reads a text file as numbered lines (`<n>\t<line>`), a window at a time. A read that stops
    /// early says which lines it showed and how to get the rest.
    pub fn file_read_with_cwd(
        &self,
        params: FileReadParams,
        working_dir: Option<&Path>,
    ) -> CallToolResult {
        let path = resolve_path(&params.path, working_dir);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return CallToolResult::error(vec![visible_text(format!(
                    "Error: cannot read {}: {error}",
                    path.display()
                ))])
            }
        };
        if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
            return CallToolResult::error(vec![visible_text(format!(
                "Error: {} is a binary file ({} bytes); this tool reads text only",
                path.display(),
                bytes.len()
            ))]);
        }

        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let first = params.offset.unwrap_or(1).max(1);
        let limit = params.limit.unwrap_or(DEFAULT_LIMIT).max(1);
        if total == 0 {
            return CallToolResult::success(vec![visible_text(format!(
                "{} is empty",
                path.display()
            ))]);
        }
        if first > total {
            return CallToolResult::error(vec![visible_text(format!(
                "Error: offset {first} is past the end of {} ({total} lines)",
                path.display()
            ))]);
        }

        let mut out = String::new();
        let mut last = first - 1;
        for (index, line) in lines.iter().enumerate().skip(first - 1).take(limit) {
            let numbered = format!("{}\t{}\n", index + 1, line);
            if out.len() + numbered.len() > MAX_BYTES && last >= first {
                break;
            }
            out.push_str(&numbered);
            last = index + 1;
        }
        if last < total {
            out.push_str(&format!(
                "[showing lines {first}-{last} of {total}; read again with offset {} for more]\n",
                last + 1
            ));
        }
        CallToolResult::success(vec![visible_text(out)])
    }
}

impl Default for ReadTool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(result: &CallToolResult) -> String {
        match &result.content[0] {
            ContentBlock::Text(text) => text.text.clone(),
            _ => panic!("expected text"),
        }
    }

    fn read(
        path: &str,
        offset: Option<usize>,
        limit: Option<usize>,
        cwd: Option<&Path>,
    ) -> CallToolResult {
        ReadTool::new().file_read_with_cwd(
            FileReadParams {
                path: path.to_string(),
                offset,
                limit,
            },
            cwd,
        )
    }

    #[test]
    fn reads_a_window_with_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "one\ntwo\nthree\nfour\n").unwrap();

        let result = read(&file.to_string_lossy(), Some(2), Some(2), None);
        assert!(!result.is_error.unwrap_or(false));
        assert_eq!(
            text_of(&result),
            "2\ttwo\n3\tthree\n[showing lines 2-3 of 4; read again with offset 4 for more]\n"
        );
    }

    #[test]
    fn reads_the_whole_file_by_default_relative_to_the_working_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.txt"), "x\ny").unwrap();

        let result = read("b.txt", None, None, Some(dir.path()));
        assert_eq!(text_of(&result), "1\tx\n2\ty\n");
    }

    #[test]
    fn refuses_binary_and_out_of_range_reads() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("c.bin");
        fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        assert!(read(&bin.to_string_lossy(), None, None, None)
            .is_error
            .unwrap_or(false));

        let txt = dir.path().join("d.txt");
        fs::write(&txt, "only\n").unwrap();
        let past = read(&txt.to_string_lossy(), Some(5), None, None);
        assert!(past.is_error.unwrap_or(false));
        assert!(text_of(&past).contains("past the end"));
    }

    #[test]
    fn missing_file_is_an_error_naming_the_path() {
        let result = read("/definitely/not/here.txt", None, None, None);
        assert!(result.is_error.unwrap_or(false));
        assert!(text_of(&result).contains("not/here.txt"));
    }
}
