export function requireJpegBlob(blob) {
  if (!blob || blob.type.toLowerCase() !== 'image/jpeg') {
    throw new Error('Could not convert this image to JPEG.')
  }
  return blob
}
