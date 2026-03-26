// Global test setup — suppress pino log output so test results aren't drowned
// in JSON log lines. Keep "error" so critical failures are still visible.
import { setLogLevel } from "../src/lib/logger.js";

setLogLevel("error");
