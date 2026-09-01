use std::collections::BTreeMap;
use std::convert::TryFrom;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, LoadOptions, Permissions};
use rand::RngExt as _;

use crate::error::{PdfrsError, Result};

/// Encrypts `doc` in place with AES-256 (PDF 2.0 revision 6), the strongest
/// scheme lopdf supports. `user_password` gates opening the document;
/// `owner_password` gates changing permissions/removing the encryption.
pub fn encrypt(doc: &mut Document, owner_password: &str, user_password: &str) -> Result<()> {
    if doc.is_encrypted() {
        return Err(PdfrsError::InvalidArgument("document is already encrypted".to_string()));
    }

    let crypt_filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let mut file_encryption_key = [0u8; 32];
    rand::rng().fill(&mut file_encryption_key);

    let state = EncryptionState::try_from(EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), crypt_filter)]),
        file_encryption_key: &file_encryption_key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password,
        user_password,
        permissions: Permissions::default(),
    })
    .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;

    doc.encrypt(&state)
        .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))
}

/// Loads an encrypted PDF and returns it already decrypted (no `/Encrypt` entry,
/// plain strings/streams), ready to be saved as a regular unencrypted PDF.
///
/// The password must be supplied at load time: lopdf only populates a
/// document's objects while loading if it can authenticate against them, so
/// loading without a password and calling `Document::decrypt` afterwards
/// silently produces an empty document for anything but an empty-password PDF.
pub fn load_decrypted(bytes: &[u8], password: &str) -> Result<Document> {
    Document::load_mem_with_options(bytes, LoadOptions::with_password(password)).map_err(PdfrsError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn encrypts_and_decrypts_round_trip() {
        let mut doc = multi_page_document(1);

        encrypt(&mut doc, "owner-secret", "user-secret").expect("encrypt should succeed");
        assert!(doc.is_encrypted());

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save should succeed");

        let reloaded = load_decrypted(&bytes, "user-secret").expect("decrypt should succeed");

        assert!(!reloaded.is_encrypted());
        assert_eq!(reloaded.get_pages().len(), 1);
    }

    #[test]
    fn rejects_wrong_password() {
        let mut doc = multi_page_document(1);
        encrypt(&mut doc, "owner-secret", "user-secret").unwrap();

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        assert!(load_decrypted(&bytes, "wrong-password").is_err());
    }

    #[test]
    fn rejects_double_encryption() {
        let mut doc = multi_page_document(1);
        encrypt(&mut doc, "owner-secret", "user-secret").unwrap();

        let err = encrypt(&mut doc, "owner-secret", "user-secret").unwrap_err();
        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }
}
