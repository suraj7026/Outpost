use serde_json::Value;

/// Preserve UTF-8 across arbitrary network chunk boundaries; bound incomplete frames.
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 16 * 1024 * 1024 {
            return Err("Live event exceeded the size limit".into());
        }
        let mut result = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|part| part == b"\n\n") {
            let frame = self.buffer.drain(..end + 2).collect::<Vec<_>>();
            let text = std::str::from_utf8(&frame).map_err(|e| e.to_string())?;
            let data = text
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() {
                result.push(serde_json::from_str(data.trim()).map_err(|e| e.to_string())?);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_unicode_and_multiple_frames() {
        let input = "data: {\"text\":\"café 東京\"}\n\ndata: {\"type\":\"heartbeat\"}\n\n";
        let mut decoder = Decoder::default();
        let mut frames = Vec::new();
        for byte in input.as_bytes() {
            frames.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["text"], "café 東京");
        assert_eq!(Decoder::default().push(input.as_bytes()).unwrap(), frames);
    }
    #[test]
    fn rejects_invalid_json_and_oversize_frames() {
        assert!(Decoder::default().push(b"data: not-json\n\n").is_err());
        assert!(Decoder::default()
            .push(&vec![0; 16 * 1024 * 1024 + 1])
            .is_err());
    }
}
