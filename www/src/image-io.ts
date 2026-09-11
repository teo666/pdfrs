/**
 * Decoding images in the browser rather than in wasm.
 *
 * The canvas already has a PNG decoder, so doing it here keeps the Rust side
 * free of any image-decoding dependency - which is what lets `stamp_image`
 * ship in the "core" wasm build instead of the 4.3MB "full" one.
 */

export interface DecodedImage {
  /** RGBA8, row-major: `width * height * 4` bytes, exactly what `stamp_image` expects. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** Above this, on the longer side, an image is scaled down before being handed to wasm. */
export const DEFAULT_MAX_SIZE = 1000;

/**
 * Decodes an image file to raw RGBA pixels, scaling it down so its longer
 * side is at most `maxSize`.
 *
 * The limit matters more than it looks: pixels travel to the worker and into
 * the PDF uncompressed-then-Flate'd, so a 4000x3000 photo would be 48MB of
 * raw RGBA. A signature needs nothing like that resolution.
 *
 * `getImageData` returns **un-premultiplied** alpha, which is exactly the
 * form a PDF `/SMask` wants - no conversion needed on either side.
 */
export async function imageToRgba(file: File, maxSize = DEFAULT_MAX_SIZE): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("impossibile ottenere un contesto 2D per decodificare l'immagine");

    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);

    // A fresh copy: `data` is a Uint8ClampedArray over the canvas's buffer,
    // and this one gets transferred to the worker.
    return { pixels: new Uint8Array(data), width, height };
  } finally {
    bitmap.close();
  }
}

/** True if the image has at least one non-opaque pixel - i.e. a signature that won't paint a white box over the page. */
export function hasTransparency(image: DecodedImage): boolean {
  for (let index = 3; index < image.pixels.length; index += 4) {
    if (image.pixels[index] !== 255) return true;
  }
  return false;
}
