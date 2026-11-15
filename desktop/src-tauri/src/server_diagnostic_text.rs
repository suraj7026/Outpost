//! Conservative local redaction. Remote strings are evidence, never commands.

pub(super) fn sanitize(input: &str) -> String {
    let mut clean = String::new();
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if matches!(
            c,
            '\u{1b}' | '\u{90}' | '\u{9b}' | '\u{9d}' | '\u{9e}' | '\u{9f}'
        ) {
            let escape = match c {
                '\u{90}' => Some('P'),
                '\u{9b}' => Some('['),
                '\u{9d}' => Some(']'),
                '\u{9e}' => Some('^'),
                '\u{9f}' => Some('_'),
                _ => chars.next(),
            };
            match escape {
                Some('[') => {
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('^') | Some('_') => {
                    while let Some(ch) = chars.next() {
                        if matches!(ch, '\u{7}' | '\u{9c}')
                            || ch == '\u{1b}' && chars.peek() == Some(&'\\')
                        {
                            if ch == '\u{1b}' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c == '\n'
            || c == '\t'
            || !c.is_control()
                && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
        {
            clean.push(c);
        }
    }
    let lines: Vec<_> = clean.lines().collect();
    // A bounded tail may begin inside a private block, without its BEGIN marker.
    let orphan_end = lines.iter().position(|line| {
        let upper = line.to_ascii_uppercase();
        upper.contains("-----END ") && (upper.contains("PRIVATE") || upper.contains("OPENSSH"))
    });
    let mut output = Vec::new();
    let mut private = false;
    let mut secret_continuation = false;
    for (index, line) in lines.iter().enumerate() {
        let upper = line.to_ascii_uppercase();
        if orphan_end.is_some_and(|end| index <= end) {
            if index == 0 {
                output.push("[REDACTED private block]".to_string());
            }
            continue;
        }
        if secret_continuation {
            if line.trim().is_empty() {
                secret_continuation = false;
            } else {
                output.push("[REDACTED sensitive continuation]".into());
                continue;
            }
        }
        if upper.contains("-----BEGIN ") && (upper.contains("PRIVATE") || upper.contains("OPENSSH"))
        {
            private = true;
            output.push("[REDACTED private block]".into());
        } else if private {
            if upper.contains("-----END ") {
                private = false;
            }
        } else {
            // Entire-line redaction avoids leaking quoted values, JSON strings, or
            // command arguments after an assignment. False positives are intentional.
            let normalized: String = line
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            let sensitive = [
                "password",
                "passwd",
                "passphrase",
                "secret",
                "token",
                "authorization",
                "credential",
                "apikey",
                "privatekey",
                "accesskey",
                "cookie",
                "bearer",
                "basicauth",
            ]
            .iter()
            .any(|key| normalized.contains(key));
            let url_secret = line
                .split_whitespace()
                .any(|word| word.contains("://") && (word.contains('@') || word.contains('?')));
            // Includes key fragments whose BEGIN/END lines lie outside the tail.
            let opaque = line
                .split(|c: char| !c.is_ascii_alphanumeric() && !"+/=_-".contains(c))
                .any(|word| word.len() >= 40);
            secret_continuation = sensitive
                && line
                    .trim_end()
                    .ends_with(['=', ':', '\\', '|', '>', '\'', '"']);
            output.push(if sensitive || url_secret || opaque {
                "[REDACTED sensitive line]".into()
            } else {
                (*line).into()
            });
        }
    }
    output.join("\n")
}

pub(super) fn truncate_tail(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    // A cut through password=value must not leave just value for the redactor.
    if text.as_bytes()[start - 1] != b'\n' {
        start = text[start..]
            .find('\n')
            .map_or(text.len(), |offset| start + offset + 1);
    }
    text.drain(..start);
    true
}

pub(super) fn truncate(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}
