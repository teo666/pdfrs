use std::collections::BTreeMap;
use std::convert::TryFrom;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, LoadOptions, Permissions};
use rand::RngExt as _;
use serde::{Deserialize, Serialize};

use crate::error::{PdfrsError, Result};

/// What whoever opens the file with the *user* password may do (PDF
/// permission flags, `/P`). Opened with the owner password, everything is
/// allowed - so restrictions only mean something with an owner password
/// different from the user one. They're a request to the reader, not a lock:
/// a reader that ignores them can still do anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPermissions {
    pub print: bool,
    /// Print at full quality, not just a degraded copy. Without `print`, no printing at all.
    pub print_high_quality: bool,
    /// Copy text and images out of the file (always allowed for accessibility tools).
    pub copy: bool,
    /// Change the content (other than with the specific permissions below).
    pub modify: bool,
    /// Add or change comments and fill in forms.
    pub annotate: bool,
    /// Fill in form fields, even without `annotate`.
    pub fill_forms: bool,
    /// Insert, rotate or delete pages and change bookmarks, even without `modify`.
    pub assemble: bool,
}

impl Default for PdfPermissions {
    fn default() -> Self {
        Self {
            print: true,
            print_high_quality: true,
            copy: true,
            modify: true,
            annotate: true,
            fill_forms: true,
            assemble: true,
        }
    }
}

impl PdfPermissions {
    fn to_lopdf(self) -> Permissions {
        let mut bits = Permissions::COPYABLE_FOR_ACCESSIBILITY;
        let flags = [
            (self.print, Permissions::PRINTABLE),
            (self.print && self.print_high_quality, Permissions::PRINTABLE_IN_HIGH_QUALITY),
            (self.copy, Permissions::COPYABLE),
            (self.modify, Permissions::MODIFIABLE),
            (self.annotate, Permissions::ANNOTABLE),
            (self.fill_forms, Permissions::FILLABLE),
            (self.assemble, Permissions::ASSEMBLABLE),
        ];
        for (on, flag) in flags {
            if on {
                bits |= flag;
            }
        }
        bits
    }

    fn from_lopdf(bits: Permissions) -> Self {
        let print = bits.contains(Permissions::PRINTABLE);
        Self {
            print,
            print_high_quality: print && bits.contains(Permissions::PRINTABLE_IN_HIGH_QUALITY),
            copy: bits.contains(Permissions::COPYABLE),
            modify: bits.contains(Permissions::MODIFIABLE),
            annotate: bits.contains(Permissions::ANNOTABLE),
            fill_forms: bits.contains(Permissions::FILLABLE),
            assemble: bits.contains(Permissions::ASSEMBLABLE),
        }
    }
}

/// The permissions an encrypted PDF grants to whoever opens it with the user
/// password, or `None` for a PDF that isn't encrypted. Needs no password:
/// the `/P` entry of the encryption dictionary is stored in the clear.
pub fn read_permissions(bytes: &[u8]) -> Result<Option<PdfPermissions>> {
    let doc = Document::load_mem(bytes)?;
    // Opened (no user password): lopdf decrypted it and kept its state.
    if let Some(state) = &doc.encryption_state {
        return Ok(Some(PdfPermissions::from_lopdf(state.permissions())));
    }
    // Still locked: the dictionary is there, unencrypted.
    match doc.get_encrypted() {
        Ok(dict) => {
            let p = dict.get(b"P").and_then(|p| p.as_i64()).unwrap_or(-1);
            // A 32-bit signed value: its bit pattern is what counts.
            Ok(Some(PdfPermissions::from_lopdf(Permissions::from_bits_truncate(p as u32 as u64))))
        }
        Err(_) => Ok(None),
    }
}

/// Encrypts `doc` in place with AES-256 (PDF 2.0 revision 6), the strongest
/// scheme lopdf supports. `user_password` gates opening the document;
/// `owner_password` gates changing permissions/removing the encryption, and
/// opening it with everything allowed. `permissions` is what the user
/// password allows (see [`PdfPermissions`]).
pub fn encrypt(
    doc: &mut Document,
    owner_password: &str,
    user_password: &str,
    permissions: PdfPermissions,
) -> Result<()> {
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
        permissions: permissions.to_lopdf(),
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

/// True when the PDF can't be read without a password: it has a user
/// password. A PDF with only an owner password (restrictions, no password to
/// open it) reads as `false` - lopdf opens it with the empty password, and
/// every operation on it already works.
pub fn needs_password(bytes: &[u8]) -> Result<bool> {
    // Loading without a password leaves a user-password PDF still encrypted
    // (and with no readable pages); any other PDF comes out decrypted.
    Ok(Document::load_mem(bytes)?.is_encrypted())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn encrypts_and_decrypts_round_trip() {
        let mut doc = multi_page_document(1);

        encrypt(&mut doc, "owner-secret", "user-secret", PdfPermissions::default()).expect("encrypt should succeed");
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
        encrypt(&mut doc, "owner-secret", "user-secret", PdfPermissions::default()).unwrap();

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        assert!(load_decrypted(&bytes, "wrong-password").is_err());
    }

    fn encrypted_bytes(owner: &str, user: &str) -> Vec<u8> {
        let mut doc = multi_page_document(3);
        encrypt(&mut doc, owner, user, PdfPermissions::default()).unwrap();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn tells_which_pdfs_need_a_password() {
        let mut plain = Vec::new();
        multi_page_document(2).save_to(&mut plain).unwrap();
        assert!(!needs_password(&plain).unwrap());
        assert!(needs_password(&encrypted_bytes("owner", "user")).unwrap());
        // Only an owner password: it opens without one.
        assert!(!needs_password(&encrypted_bytes("owner", "")).unwrap());
    }

    #[test]
    fn opens_with_either_the_user_or_the_owner_password() {
        let bytes = encrypted_bytes("owner", "user");
        assert_eq!(load_decrypted(&bytes, "user").unwrap().get_pages().len(), 3);
        assert_eq!(load_decrypted(&bytes, "owner").unwrap().get_pages().len(), 3);
    }

    #[test]
    fn rejects_double_encryption() {
        let mut doc = multi_page_document(1);
        encrypt(&mut doc, "owner-secret", "user-secret", PdfPermissions::default()).unwrap();

        let err = encrypt(&mut doc, "owner-secret", "user-secret", PdfPermissions::default()).unwrap_err();
        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }

    fn restricted_bytes(owner: &str, user: &str, permissions: PdfPermissions) -> Vec<u8> {
        let mut doc = multi_page_document(2);
        encrypt(&mut doc, owner, user, permissions).unwrap();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_plain_pdf_has_no_permissions_to_read() {
        let mut plain = Vec::new();
        multi_page_document(1).save_to(&mut plain).unwrap();
        assert_eq!(read_permissions(&plain).unwrap(), None);
    }

    #[test]
    fn restrictions_are_written_and_read_back_even_without_the_password() {
        let restricted = PdfPermissions {
            print: false,
            copy: false,
            modify: false,
            ..PdfPermissions::default()
        };
        let bytes = restricted_bytes("owner", "user", restricted);

        // Locked: read from /P, no password needed.
        let read = read_permissions(&bytes).unwrap().expect("encrypted");
        // No printing at all also means no printing at full quality.
        assert_eq!(read, PdfPermissions { print_high_quality: false, ..restricted });

        // /Perms agrees with /P: the file still opens with either password.
        assert_eq!(load_decrypted(&bytes, "user").unwrap().get_pages().len(), 2);
        assert_eq!(load_decrypted(&bytes, "owner").unwrap().get_pages().len(), 2);
    }

    #[test]
    fn restrictions_with_no_password_to_open_are_read_too() {
        let restricted = PdfPermissions {
            assemble: false,
            annotate: false,
            ..PdfPermissions::default()
        };
        let bytes = restricted_bytes("owner", "", restricted);

        assert!(!needs_password(&bytes).unwrap());
        assert_eq!(read_permissions(&bytes).unwrap(), Some(restricted));
    }

    #[test]
    fn everything_allowed_by_default_and_accessibility_copy_always() {
        let bytes = restricted_bytes("owner", "user", PdfPermissions::default());
        assert_eq!(read_permissions(&bytes).unwrap(), Some(PdfPermissions::default()));

        let none = PdfPermissions {
            print: false,
            print_high_quality: false,
            copy: false,
            modify: false,
            annotate: false,
            fill_forms: false,
            assemble: false,
        };
        assert_eq!(none.to_lopdf(), Permissions::COPYABLE_FOR_ACCESSIBILITY);
    }
}
