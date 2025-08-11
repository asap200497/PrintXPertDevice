import express ,{Request, Response, NextFunction} from 'express';
import fileUpload from 'express-fileupload';

import fs from "fs";
import cors from 'cors';
import https from "https";

import {router } from './routes'
import path from 'path'
import { isAuthenticated } from './middlewares/isAuthenticated'
import cron from "node-cron"

const app = express();

app.disable('x-powered-by');

app.use(express.json());
app.use(cors());
app.set('trust proxy', true);
app.use(router);
app.use(
   '/files',
   express.static(path.resolve(__dirname,'..','tmp'))
)

app.use(
   '/pdfs', isAuthenticated,
   express.static(process.env.STORAGE)
)

cron.schedule("25 8 * * *",() => {
   console.log("Maintenance task");
})

const dev = process.env.NODE_ENV !== "production";

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
   if (err instanceof Error) {
      res.status(400).json({
         error: err.message
      })
      return
   }
   res.status(500).json({
         status: 'error',
         message: 'Internal Server Error'
   });
   
   
 });

 if (dev) {
    app.listen(process.env.PORTBACK,() => console.log('servidor HTTP online porta ',process.env.PORTBACK ))

 }
 else {
      const options = {
         key: fs.readFileSync(process.env.SITE_KEY),
      cert: fs.readFileSync(process.env.SITE_CERT),
      };



      https.createServer(options, app).listen(process.env.PORTBACK, () => {
         console.log("? HTTPS server running on port ", process.env.PORTBACK);
      });


}
