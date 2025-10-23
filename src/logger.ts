import { createLogger, format, transports } from 'winston';
import path from 'path';

// Use DATA_DIR environment variable if set, otherwise use current directory
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const LOG_FILE = path.join(DATA_DIR, 'app.log');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: LOG_FILE })
  ]
});

export default logger;
