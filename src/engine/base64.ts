// Base64 → bytes for model payloads crossing the IPC boundary (the backend
// serves model files as bare standard base64, same encoding the vrm backend
// uses for its model payloads).

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
