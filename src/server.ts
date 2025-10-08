
import fs from "fs";
import path from "path";
import { api } from "./services/api";
import { finished } from "stream/promises";
import "dotenv/config"; 
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
const execFileAsync = promisify(execFile);


export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function printPdf(pdfPath: string, printer: string, options: string[] = []) {
  // Example options: ["sides=two-sided-long-edge", "media=A4", "fit-to-page"]
  const args = ["-d", printer, "-o", "media=A4", ...options, pdfPath];

  const { stdout } = await execFileAsync("lp", args);
  // stdout looks like: "request id is KM-C751i-123 (1 file(s))\n"
  const match = stdout.match(/request id is (.+?-\d+)/i);
  return match?.[1] ?? stdout.trim();
}

function getFilenameFromCD(disposition?: string): string | null {
  if (!disposition) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(disposition);
  return m?.[1] ? decodeURIComponent(m[1].replace(/"/g, "")) : null;
}

function getMacAddress(): string  {
    try {
        const netPath = "/sys/class/net";
        const interfaces = fs.readdirSync(netPath);

        for (const iface of interfaces) {
            if (iface === "lo") continue; // skip loopback
            const addressPath = path.join(netPath, iface, "address");
            if (fs.existsSync(addressPath)) {
                const mac = fs.readFileSync(addressPath, "utf8").trim();
                if (mac && mac !== "00:00:00:00:00:00") {
                    return mac;
                }
            }
        }
        return "";
    } catch (err) {
        console.error("Error reading MAC address:", err);
        return "";
    }
}

function getRaspberryPiSerial(): string | null {
    try {
        const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
        const match = cpuInfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
        const mac = getMacAddress();
        const idx =  mac + (match?.[1] ?? "");
        return idx;
        //return match?.[1] ?? null; // ? null if undefined
    } catch (err) {
        console.error("Error reading CPU serial:", err);
        return null;
    }
}

const serial = getRaspberryPiSerial();
console.log("Device serial:", serial);

export async function downloadPdfToFile(prod: string) {
  const resp = await api.get("/devicedownload/" + prod, { responseType: "stream", timeout: 30_000});
  
  // Pick a filename from Content-Disposition or fallback
  const cd = resp.headers["content-disposition"] as string | undefined;
  const filename = getFilenameFromCD(cd) ?? `file-${Date.now()}.pdf`;

  // Make sure directory exists
  await fs.promises.mkdir("/tmp/pdfdownload", { recursive: true });
  const outPath = path.join("/tmp/pdfdownload", uuidv4()+ "-" + filename);

  // Pipe and await completion
  const writeStream = fs.createWriteStream(outPath);
  resp.data.pipe(writeStream);
  await finished(writeStream);

  // (Optional) sanity check first bytes for PDF magic
  const fd = await fs.promises.open(outPath, "r");
  const buf = Buffer.alloc(5);
  await fd.read(buf, 0, 5, 0);
  await fd.close();
  if (buf.toString() !== "%PDF-") {
    throw new Error(`Downloaded file is not a PDF: ${outPath}`);
  }

  return outPath;
}


function toBufferLoose(input: any): Buffer {
  if (!input) throw new TypeError("empty binary payload");

  // Already a Buffer?
  if (Buffer.isBuffer(input)) return input;

  // Uint8Array / ArrayBuffer
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));

  // Base64 string (optionally with data: prefix)
  if (typeof input === "string") {
    const base64 = input.startsWith("data:")
      ? input.substring(input.indexOf(",") + 1)
      : input;
    return Buffer.from(base64, "base64");
  }

  // Node Buffer JSON shape: { type: "Buffer", data: number[] }
  if (typeof input === "object" && input.type === "Buffer" && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }

  // Plain number[]
  if (Array.isArray(input)) return Buffer.from(input);

  // Object with numeric keys: { "0": 37, "1": 80, ... }
  if (typeof input === "object") {
    const keys = Object.keys(input);
    const allNumeric = keys.every(k => /^\d+$/.test(k));
    if (allNumeric) {
      const arr = keys.sort((a, b) => Number(a) - Number(b)).map(k => input[k]);
      return Buffer.from(Uint8Array.from(arr));
    }
  }

  throw new TypeError(
    "Unsupported binary shape; expected Buffer/Uint8Array/ArrayBuffer/number[]/" +
    '{type:"Buffer",data:number[]} or base64 string'
  );
}

interface IProduto {
    id: string;
    banner: string;
    originalbanner: string;
    banner2: string;
    originalbanner2: string;
    sides: boolean;
    color: string;    
    weight: string;
    finishing: string;
    sides2: boolean;
    color2: string;
    weight2: string;
    finishing2: string;

  }

interface IProdutos {
  preco: string;
  quantidade: number;
  produtos: IProduto[];
}

interface IOrdemServico {
    id: string;
    os_id: string;
    produto_id: string,
}

interface IComando {
    cmd: String;
    filename: String;
    mimeType: String;
    data: Uint8Array | number[];
    lock: boolean;
    created_at: Date;
}

interface ICmd {
    order?: IOrdemServico;
    cmd?:    IComando;

}

import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

interface PrinterOptions {
  [key: string]: {
    description: string;
    default: string;
    choices: string[];
  };
}

/**
 * Get available printer options from lpoptions -l
 * @param printerName The name of the printer (use -p NAME)
 */
async function getPrinterOptions(printerName: string): Promise<PrinterOptions> {
  const { stdout } = await execAsync(`lpoptions -p ${printerName} -l`);
  const lines = stdout.trim().split("\n");
  const options: PrinterOptions = {};

  for (const line of lines) {
    // Example line:
    // Duplex/Duplex: *None DuplexNoTumble DuplexTumble
    const match = line.match(/^([^\/]+)\/([^:]+):\s+(.+)$/);
    if (!match) continue;


    const key = (match[1] || "").trim();
    const description = (match[2] || "").trim();
    const values = (match[3] || "")
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean);

    // Default is prefixed with '*'
    const defaultValue = values.find((v) => v.startsWith("*"))?.replace("*", "") ?? "";
    const choices = values.map((v) => v.replace("*", ""));

    options[key] = {
      description,
      default: defaultValue,
      choices,
    };
  }

  return options;
}






// Function that calls the webservice
async function pollService() {
    try {

        const response = await api.get("/nextorder/" + serial);
        const cmd = response.data;
        if (response.data.cmd != null ){
            await fs.promises.mkdir("/tmp/pdfdownload", { recursive: true });
            const outPath = path.join("/tmp/pdfdownload", uuidv4()+ "-" + cmd.cmd.filename);
            const buffer = toBufferLoose(cmd.cmd.data);
            await fs.promises.writeFile(outPath, buffer);
            const jobid = await printPdf(outPath,"PDF");
            fs.promises.unlink(outPath);
        }
        if (response.data.order != null) {
                console.log("Order",cmd.order);
            
                await api.put("/deviceaction/" + cmd.order.id + "?action=downloadstart");
                try {
                  const pathOnDisk = await downloadPdfToFile(cmd.order.produto_id);
                  try {
                  const depois = await api.put("/deviceaction/" + cmd.order.id + "?action=downloadend");   

                  } catch(err) {
                      console.error("Failed to notify server of completion:", err);
                  }   

               
                  const jobid = await printPdf(pathOnDisk,"PDF");
                  console.log("job " + jobid + " arquivo " + pathOnDisk);
                  try {
                  const depois = await api.put("/deviceaction/" + cmd.order.id + "?action=printend");   

                  } catch(err) {
                      console.error("Failed to notify server of completion:", err);
                  }   
                  
                  fs.rm(pathOnDisk, (err) => {
                      if (err) {
                          console.error("Failed to delete file:", err);
                      } else {
                          console.log("File deleted successfully");
                      }
                  });

                  
                }
                catch (err) {
                  const depois = await api.put("/deviceaction/" + cmd.order.id + "?action=downloaderror");   

                }

        }

                   
;

    } catch (error) {
        console.error("Error calling webservice:");
    }
}

// Call immediately on startup

(async function loop() {
  while (true) {
    await pollService();
    await new Promise(r => setTimeout(r, 15 * 1000));
  }
})();





