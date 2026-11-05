/** PNG bytes in the form the Even bridge expects for image containers. */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<number[]> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}
