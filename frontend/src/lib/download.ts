/**
 * Downloads a URL as a file with a specific filename by fetching it into a
 * blob first (works across origins when the host sends CORS headers, which
 * Cloudinary does with `Access-Control-Allow-Origin: *`).
 */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not download file (${res.status}).`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}