import assert from "node:assert/strict";
import test from "node:test";
import { collectInitAdminInput, parseInitAdminArgs, validateInteractivePassword } from "../scripts/init-admin.js";

test("首次管理员命令解析不接收密码参数并校验两次隐式输入", async () => {
  assert.deepEqual(parseInitAdminArgs(["--username", "admin", "--display-name=系统管理员"]), {
    username: "admin",
    displayName: "系统管理员",
    help: false
  });
  assert.throws(() => parseInitAdminArgs(["--password", "不应进入命令行"]), /未知参数/);
  assert.throws(() => validateInteractivePassword("不足十二位", "不足十二位"), /至少为 12 位/);
  assert.throws(() => validateInteractivePassword("secure-password-2026", "secure-password-2027"), /不一致/);
  assert.equal(validateInteractivePassword("secure-password-2026", "secure-password-2026"), "secure-password-2026");

  const resolved = await collectInitAdminInput({
    argv: ["--username", "admin", "--display-name", "系统管理员"],
    env: { HH_BOOTSTRAP_PASSWORD: "secure-password-2026" },
    input: { isTTY: false },
    output: { isTTY: false }
  });
  assert.deepEqual(resolved, { username: "admin", displayName: "系统管理员", password: "secure-password-2026" });
});
