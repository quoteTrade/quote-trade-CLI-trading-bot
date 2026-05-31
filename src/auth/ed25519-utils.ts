import { generateKeyPairSync } from "node:crypto";
export function generateEd25519KeyPair(): { publicKeyPem:string; privateKeyPem:string } { const pair = generateKeyPairSync("ed25519", { publicKeyEncoding:{type:"spki",format:"pem"}, privateKeyEncoding:{type:"pkcs8",format:"pem"} }); return { publicKeyPem:String(pair.publicKey), privateKeyPem:String(pair.privateKey) }; }
export function printEd25519KeyPairDetails(pair:{publicKeyPem:string;privateKeyPem:string}, name:string): void { console.log(`Ed25519 key ${name}\nPUBLIC:\n${pair.publicKeyPem}\nPRIVATE:\n${pair.privateKeyPem}`); }
