// Instalado no início do pacote: o código do computador usa "Buffer" e "process" como se fossem do Node.
import { Buffer } from 'buffer';
export { Buffer };
export const process = { env: {}, platform: 'android', versions: {}, nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)) };
