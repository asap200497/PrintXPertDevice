
import fs from "fs";
import path from "path";
import { api } from "./services/api";
import { finished } from "stream/promises";
import "dotenv/config"; 
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
const execFileAsync = promisify(execFile);


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



interface IProduto {
  preco: string;
  quantidade: number;
  produtos: {
    id: string;
    banner: string;
    originalbanner: string;
  };
}
interface Iordem {
    id: string;
    numero: number;
    total: number;
    produtos: IProduto[];
}

// Function that calls the webservice
async function pollService() {
    try {

        const response = await api.get<Iordem>("/nextorder/" + serial);
        const order = response.data;
        if (response.data != null) {
            
            for ( const prod of order.produtos ) {
                const pathOnDisk = await downloadPdfToFile(prod.produtos.id);
                const jobid = await printPdf(pathOnDisk,"HP_DeskJet_5200_series_CEB583");
                console.log("job " + jobid + " arquivo " + pathOnDisk);
                fs.rm(pathOnDisk, (err) => {
                    if (err) {
                        console.error("Failed to delete file:", err);
                    } else {
                        console.log("File deleted successfully");
                    }
                });
             }            

        }
        else    console.log("vazio");
                   
;

    } catch (error) {
        console.error("Error calling webservice:", error);
    }
}

// Call immediately on startup
pollService();

// Repeat every 10 minutes (600_000 ms)
setInterval(pollService,  150 * 1000);





