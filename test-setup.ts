/**
 * Test preload - point the user-level config at a temp dir so tests never touch ~/.config/ml-ralph
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ml-ralph-xdg-"));
