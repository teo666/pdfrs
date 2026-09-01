export async function fileToUint8Array(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/**
 * Wires both a `<input type="file">` and a drag & drop zone to the same
 * callback, so a panel doesn't need to handle the two input paths separately.
 */
export function setupFileInput(
  dropzone: HTMLElement,
  input: HTMLInputElement,
  onFiles: (files: File[]) => void,
): void {
  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list).filter(isPdf);
    if (files.length > 0) onFiles(files);
  };

  input.addEventListener("change", () => pickFiles(input.files));

  dropzone.addEventListener("click", () => input.click());

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dropzone--active");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dropzone--active");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dropzone--active");
    pickFiles(event.dataTransfer?.files ?? null);
  });
}
