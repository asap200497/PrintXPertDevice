import fs from "fs";
import path, { basename, join } from "path";
import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { tmpdir } from "os";
import { execFile, exec } from "child_process";
import util, { promisify } from "util";
import { finished } from "stream/promises";
import { api } from "./services/api";
import {
  PDFDocument,
  rgb,
  degrees,
  PDFArray,
  PDFName,
  PDFNumber,
} from "pdf-lib";
import QRCode from "qrcode";

// ----------------------------- helpers -----------------------------
const execFileAsync = promisify(execFile);
const execAsync = util.promisify(exec);

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

function mmToPt(mm: number) {
  return (mm * 72) / 25.4;
}


function getRaspberryPiSerial(): string | null {
  try {
    const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const match = cpuInfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
    const mac = getMacAddress();
    return mac + (match?.[1] ?? "");
  } catch (err) {
    console.error("Error reading CPU serial:", err);
    return null;
  }
}


let jwt = "";
let jwtexpiration = new Date();



async function login() {
  const now = new Date();

  if (jwt && now < jwtexpiration) {
      return jwt ;

  }

  const response = await api.post("/session", { login: getRaspberryPiSerial(), password: process.env.API_PASSWORD } )
  if (response?.data?.token) {
    jwt = response.data.token;
    jwtexpiration = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return jwt;
  }
  else {
    jwt = "";
    throw "Erro login"
  }
}


function readBox(
  pdfDoc: PDFDocument,
  page: any,
  name: "TrimBox" | "CropBox" | "BleedBox" | "ArtBox" | "MediaBox"
) {
  const dict = pdfDoc.context.lookup(page.ref);
  if (!dict) return null;
  const raw = (dict as any).get(PDFName.of(name));
  if (!raw || !(raw instanceof PDFArray)) return null;

  const x1 = (raw.get(0) as PDFNumber).asNumber();
  const y1 = (raw.get(1) as PDFNumber).asNumber();
  const x2 = (raw.get(2) as PDFNumber).asNumber();
  const y2 = (raw.get(3) as PDFNumber).asNumber();
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function pickVisibleBox(pdfDoc: PDFDocument, page: any) {
  // Prefer final cut size → then what viewer likely shows → then full canvas
  return (
    readBox(pdfDoc, page, "TrimBox") ??
    readBox(pdfDoc, page, "CropBox") ??
    readBox(pdfDoc, page, "BleedBox") ??
    readBox(pdfDoc, page, "ArtBox") ??
    readBox(pdfDoc, page, "MediaBox") ?? {
      x: 0,
      y: 0,
      w: page.getWidth(),
      h: page.getHeight(),
    }
  );
}
function resolveBottomRightInBox(page: any, box: {x:number;y:number;w:number;h:number}, sizePt: number, insetPt: number) {
  const rot = ((page.getRotation().angle ?? 0) % 360 + 360) % 360;
  switch (rot) {
    case 0:
      return { x: box.x + (box.w - sizePt - insetPt), y: box.y + insetPt, rotate: 0 };
    case 90:
      return { x: box.x + insetPt, y: box.y + (box.h - sizePt - insetPt), rotate: 90 };
    case 180:
      return { x: box.x + insetPt, y: box.y + (box.h - sizePt - insetPt), rotate: 180 };
    case 270:
      return { x: box.x + (box.w - sizePt - insetPt), y: box.y + insetPt, rotate: 270 };
    default:
      return { x: box.x + (box.w - sizePt - insetPt), y: box.y + insetPt, rotate: rot };
  }
}
/** Compute bottom-right inside the *visible* box (Crop→Trim→Media) and account for /Rotate. */
function resolveVisualBottomRight(
  pdfDoc: PDFDocument,
  page: any,
  sizePt: number,
  insetPt: number
) {
  const crop = readBox(pdfDoc, page, "CropBox");
  const trim = readBox(pdfDoc, page, "TrimBox");
  const media = readBox(pdfDoc, page, "MediaBox");
  const box = crop ?? trim ?? media ?? { x: 0, y: 0, w: page.getWidth(), h: page.getHeight() };

  const rot = ((page.getRotation().angle ?? 0) % 360 + 360) % 360;

  // map “visual bottom-right” to unrotated page coordinates
  switch (rot) {
    case 0:
      return {
        x: box.x + (box.w - sizePt - insetPt),
        y: box.y + insetPt,
        rotate: 0,
      };
    case 90:
      return {
        x: box.x + insetPt,
        y: box.y + (box.h - sizePt - insetPt),
        rotate: 90,
      };
    case 180:
      return {
        x: box.x + insetPt,
        y: box.y + (box.h - sizePt - insetPt),
        rotate: 180,
      };
    case 270:
      return {
        x: box.x + (box.w - sizePt - insetPt),
        y: box.y + insetPt,
        rotate: 270,
      };
    default:
      // uncommon non-orthogonal; fallback like 0
      return {
        x: box.x + (box.w - sizePt - insetPt),
        y: box.y + insetPt,
        rotate: rot,
      };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFilenameFromCD(disposition?: string): string | null {
  if (!disposition) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(disposition);
  return m?.[1] ? decodeURIComponent(m[1].replace(/"/g, "")) : null;
}

function getMacAddress(): string {
  try {
    const netPath = "/sys/class/net";
    const interfaces = fs.readdirSync(netPath);
    for (const iface of interfaces) {
      if (iface === "lo") continue;
      const addressPath = path.join(netPath, iface, "address");
      if (fs.existsSync(addressPath)) {
        const mac = fs.readFileSync(addressPath, "utf8").trim();
        if (mac && mac !== "00:00:00:00:00:00") return mac;
      }
    }
    return "";
  } catch (err) {
    console.error("Error reading MAC address:", err);
    return "";
  }
}

function toBufferLoose(input: any): Buffer {
  if (!input) throw new TypeError("empty binary payload");
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  if (typeof input === "string") {
    const base64 = input.startsWith("data:")
      ? input.substring(input.indexOf(",") + 1)
      : input;
    return Buffer.from(base64, "base64");
  }
  if (typeof input === "object" && input?.type === "Buffer" && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }
  if (Array.isArray(input)) return Buffer.from(input);
  if (typeof input === "object") {
    const keys = Object.keys(input);
    const allNumeric = keys.every((k) => /^\d+$/.test(k));
    if (allNumeric) {
      const arr = keys.sort((a, b) => Number(a) - Number(b)).map((k) => (input as any)[k]);
      return Buffer.from(Uint8Array.from(arr));
    }
  }
  throw new TypeError(
    "Unsupported binary shape; expected Buffer/Uint8Array/ArrayBuffer/number[]/{type:'Buffer',data:number[]} or base64 string"
  );
}


export async function genTempPdfQr( 
  pdfPath: string,
  serial: string,
  insetMm = 0,
  qrSizeMm = 10
  
) {
  const input = await readFileAsync(pdfPath);
  const pdfDoc = await PDFDocument.load(input);

  // 2) Add QR (if any) at bottom-right of the *visible* area for the last page
  if (serial) {
    const lastPage = pdfDoc.getPage(pdfDoc.getPageCount() - 1);

    // generate compact QR with solid white bg
    const qrPng = await QRCode.toBuffer(serial, {
      errorCorrectionLevel: "L",
      margin: 0,
      scale: 2,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    const qrImage = await pdfDoc.embedPng(qrPng);

    const qrSizePt = mmToPt(qrSizeMm);
    const insetPt = mmToPt(insetMm);

    const box = pickVisibleBox(pdfDoc, lastPage);
    const minSafeInset = Math.max(insetPt, mmToPt(2));
    const pos = resolveBottomRightInBox(lastPage, box, qrSizePt, minSafeInset);

    // white pad behind QR to protect against dark backgrounds
    const pad = mmToPt(1.5);
    lastPage.drawRectangle({
      x: pos.x - pad,
      y: pos.y - pad,
      width: qrSizePt + pad * 2,
      height: qrSizePt + pad * 2,
      color: rgb(1, 1, 1),
    });
      lastPage.drawImage(qrImage, {
        x: pos.x,
        y: pos.y,
        width: qrSizePt,
        height: qrSizePt,
        rotate: degrees(pos.rotate),
      });
  }

  // 3) Save to a temp file
  const stampedBytes = await pdfDoc.save();
  const tempPdf = join(tmpdir(), `stamped_${Date.now()}_${basename(pdfPath)}`);
  await writeFileAsync(tempPdf, stampedBytes);
  return tempPdf;
} 

// ----------------------------- printing -----------------------------
export async function printPdf(
  pdfPath: string,
  serial: string,
  printer: string,
  options: string[] = [],
  insetMm = 0,
  qrSizeMm = 10
) {
  // 1) Read original PDF
  const tempPdf = await genTempPdfQr(pdfPath,serial,insetMm,qrSizeMm);
  // 4) Print with lp
  try {
    const args = ["-d", printer, ...options, tempPdf];
    const { stdout } = await execFileAsync("lp", args);
    const match = stdout.match(/request id is (.+?-\d+)/i);
    return match?.[1] ?? stdout.trim();
  } finally {
    try {
      await unlinkAsync(tempPdf);
    } catch {
      // ignore
    }
  }
}

// ----------------------------- download -----------------------------
export async function downloadPdfToFile(prod: string, capa: boolean) {
  const url = "/devicedownload/" + prod + (capa ? "?capa=true" : "");
  const resp = await api.get(url, {
        headers: {
          Authorization: `Bearer ${await login()}`,
        }, responseType: "stream", timeout: 30_000 });

  const cd = resp.headers["content-disposition"] as string | undefined;
  const filename = getFilenameFromCD(cd) ?? `file-${Date.now()}.pdf`;

  await fs.promises.mkdir("/tmp/pdfdownload", { recursive: true });
  const outPath = path.join("/tmp/pdfdownload", uuidv4() + "-" + filename);

  const writeStream = fs.createWriteStream(outPath);
  resp.data.pipe(writeStream);
  await finished(writeStream);

  // sanity check magic
  const fd = await fs.promises.open(outPath, "r");
  const buf = Buffer.alloc(5);
  await fd.read(buf, 0, 5, 0);
  await fd.close();
  if (buf.toString() !== "%PDF-") {
    throw new Error(`Downloaded file is not a PDF: ${outPath}`);
  }

  return outPath;
}

// ----------------------------- types -----------------------------
interface IProduto {
  id: string;
  banner: string;
  capa: true;
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
  seriais?: { serial: string }[];
}
interface IProdutos {
  preco: string;
  quantidade: number;
  produtos: IProduto[];
}
interface IOrdemServico {
  id: string;
  os_id: string;
  produto_id: string;
  capa?: boolean;
  seriais?: { serial: string }[];
  qtdadicional?: number;
}
interface IComando {
  cmd: string;
  filename: string;
  mimeType: string;
  data: Uint8Array | number[];
  lock: boolean;
  created_at: Date;
}
interface ICmdPayload {
  order?: IOrdemServico;
  cmd?: IComando;
}

// ----------------------------- printer options (unchanged) -----------------------------
interface PrinterOptions {
  [key: string]: {
    description: string;
    default: string;
    choices: string[];
  };
}
export async function getPrinterOptions(printerName: string): Promise<PrinterOptions> {
  const { stdout } = await execAsync(`lpoptions -p ${printerName} -l`);
  const lines = stdout.trim().split("\n");
  const options: PrinterOptions = {};
  for (const line of lines) {
    const match = line.match(/^([^\/]+)\/([^:]+):\s+(.+)$/);
    if (!match) continue;
    const key = (match[1] || "").trim();
    const description = (match[2] || "").trim();
    const values = (match[3] || "")
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean);
    const defaultValue = values.find((v) => v.startsWith("*"))?.replace("*", "") ?? "";
    const choices = values.map((v) => v.replace("*", ""));
    options[key] = { description, default: defaultValue, choices };
  }
  return options;
}

// ----------------------------- poll loop -----------------------------
const deviceSerial = getRaspberryPiSerial();
console.log("Device serial:", deviceSerial);
console.log("Impressora:", process.env.IMPRESSORA);
async function pollService() {
  try {
    let didSomething = false;
    const response = await api.get("/nextorder/" + deviceSerial, {headers: { Authorization: `Bearer ${await login()}`}});
    const payload: ICmdPayload = response.data;

    // raw command with pdf payload
    if (payload?.cmd) {
      didSomething = true;
      await fs.promises.mkdir("/tmp/pdfdownload", { recursive: true });
      const outPath = path.join("/tmp/pdfdownload", uuidv4() + "-" + payload.cmd.filename);
      const buffer = toBufferLoose(payload.cmd.data);
      await fs.promises.writeFile(outPath, buffer);
      try {
        const jobid = await printPdf(outPath, "", process.env.IMPRESSORA || "");
        console.log("job", jobid, "file", outPath);
      } finally {
        await fs.promises.unlink(outPath).catch(() => {});
      }
    }

    // order → fetch PDF from server and print N copies with serials
    if (payload?.order) {
      didSomething = true;
      const order = payload.order;


      await api.put(`/deviceaction/${order.id}?action=downloadstart`, { data: {} }, {headers: { Authorization: `Bearer ${await login()}`}}).catch(() => {}, );
      try {
        const pathOnDisk = await downloadPdfToFile(order.produto_id, !!order.capa);

        // how many prints? prefer qtdadicional; fallback to seriais length; else 1
        const copies =
          (order as any).qtdadicional ?? order.seriais?.length ?? 1;

        for (let i = 0; i < copies; i++) {
          const serial = order.seriais?.[i]?.serial ?? "";
          const jobid = await printPdf(pathOnDisk, serial, process.env.IMPRESSORA || "");
          console.log("job", jobid, "file", pathOnDisk, "serial", serial);
        }

        await api.put(`/deviceaction/${order.id}?action=downloadend`,{ data: {} }, {headers: { Authorization: `Bearer ${await login()}`}}).catch(() => {});
        await api.put(`/deviceaction/${order.id}?action=printend`, { data: {} }, {headers: { Authorization: `Bearer ${await login()}`}}).catch(() => {});
        await fs.promises.unlink(pathOnDisk).catch(() => {});
      } catch (err) {
        console.error("download/print error:", err);
        await api.put(`/deviceaction/${order.id}?action=downloaderror`,{ data: {} }, {headers: { Authorization: `Bearer ${await login()}`}}).catch(() => {});
      }
    }

    if (!didSomething) {
      await sleep(15_000);
    }
  } catch (error) {
    console.error("Error calling webservice:", error);
    throw error;
  }
}

(async function loop() {
  while (true) {
    try {
      await pollService();
    } catch {
      console.log("waiting");
      await sleep(15_000);
    }
  }
})();
