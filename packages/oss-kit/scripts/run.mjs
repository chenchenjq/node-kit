import { spawn } from "node:child_process";
export function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
