import * as fs from 'fs';
import Log from '../utils/log';
import { download, decrypt, mergeVideo } from '../utils/media';
import axios from 'axios';
import { exec } from '../utils/system';
const path = require('path');

export interface DownloaderConfig {
    threads?: number;
    output?: string;
}

export interface Chunk {
    url: string;
    filename: string;
}

class Downloader {
    tempPath: string;
    outputPath: string = './output.mkv';
    m3u8Path: string;

    chunks: Chunk[];
    outputFileList: string[];

    totalChunks: number;
    finishedChunks: number = 0;
    threads: number = 5;
    runningThreads: number = 0;
   
    m3u8Content: string;

    key: string;
    iv: string;
    prefix: string;

    /**
     * 
     * @param m3u8Path 
     * @param config
     * @param config.threads 线程数量 
     */
    constructor(m3u8Path: string, { threads, output }: DownloaderConfig = {
        threads: 5
    }) {
        if (threads) {
            this.threads = threads;
        }

        if (output) {
            this.outputPath = output;
        }
      
        this.m3u8Path = m3u8Path;
        this.tempPath = path.resolve(__dirname, '../../temp');
    }

    async init() {
        let m3u8Content;
        if (!fs.existsSync(this.tempPath)) {
            fs.mkdirSync(this.tempPath);
        }
        if (this.m3u8Path.startsWith('http')) {
            Log.info('Start fetching M3U8 file.')
            try {
                const response = await axios.get(this.m3u8Path);
                Log.info('M3U8 file fetched.');
                m3u8Content = response.data;
            } catch (e) {
                Log.error('Fail to fetch M3U8 file.')
            }
        } else {
            // is a local file path
            if (!fs.existsSync(this.m3u8Path)) {
                Log.error(`File '${this.m3u8Path}' not found.`);
            }
            Log.info('Loading M3U8 file.');
            m3u8Content = fs.readFileSync(this.m3u8Path).toString();
        }
        this.m3u8Content = m3u8Content;
        // parse m3u8
        const key = m3u8Content.match(/EXT-X-KEY:METHOD=AES-128,URI="(.+)"/)[1];
        const iv = m3u8Content.match(/IV=0x(.+)/)[1];
        if (!key || !iv) {
            Log.error('Unsupported site.');
        }
        if (key.startsWith('abemafresh')) {
            Log.info('Site comfirmed: FreshTV.');
            const parser = await import('./parsers/freshtv');
            const parseResult = parser.default.parse({
                key,
                iv
            });
            [this.key, this.iv, this.prefix] = [parseResult.key, parseResult.iv, parseResult.prefix];
            Log.info(`Key: ${this.key}; IV: ${this.iv}.`);
        }
    }

    async download() {
        Log.info(`Start downloading with ${this.threads} thread(s).`);
        this.chunks = this.m3u8Content.match(/(.+\.ts.*)/ig).map(chunk => {
            return {
                url: this.prefix + chunk,
                filename: chunk.match(/\/([^\/]+?\.ts)/)[1]
            };
        });
         // DEBUG
         this.chunks = this.chunks.slice(0, 10);
         // DEBUG
        this.totalChunks = this.chunks.length;
        this.outputFileList = this.chunks.map(chunk => {
            return path.resolve(this.tempPath, `./${chunk.filename}.decrypt`);
        })
        this.checkQueue();
    }

    handleTask(task: Chunk) {
        return new Promise(async (resolve, reject) => {
            Log.debug(`Downloading ${task.filename}`);
            try {
                await download(task.url, path.resolve(this.tempPath, `./${task.filename}`));
                Log.debug(`Download ${task.filename} succeed.`);
                await decrypt(path.resolve(this.tempPath, `./${task.filename}`), path.resolve(this.tempPath, `./${task.filename}`) + '.decrypt', this.key, this.iv);
                Log.debug(`Decrypt ${task.filename} succeed`);
                resolve();
            } catch (e) {
                Log.info(`Download or decrypt ${task.filename} failed. Retry later.`);
                reject(e);
            }            
        });
    }

    checkQueue() {
        if (this.chunks.length > 0 && this.runningThreads < this.threads) {
            const task = this.chunks.shift();
            this.runningThreads++;
            this.handleTask(task).then(() => {
                this.finishedChunks++;
                this.runningThreads--;
                Log.info(`Proccess ${task.filename} finished. (${this.finishedChunks} / ${this.totalChunks} or ${(this.finishedChunks / this.totalChunks * 100).toFixed(2)}%)`);
                this.checkQueue();
            }).catch(e => {
                this.runningThreads--;
                this.chunks.push(task);
                this.checkQueue();
            });
            this.checkQueue();
        }
        if (this.chunks.length === 0 && this.runningThreads === 0) {
            Log.info('All chunks downloaded. Start merging chunks.');
            mergeVideo(this.outputFileList, this.outputPath).then(async () => {
                Log.info('End of merging.');
                Log.info('Starting cleaning temporary files.');
                await exec(`rm -rf ${this.tempPath}`);
                Log.info(`All finished. Check your file at [${this.outputPath}] .`);
            });
        }
    }
}

export default Downloader;