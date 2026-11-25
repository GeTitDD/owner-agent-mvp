// 测试里的 waitFor 统一出口：默认上限 15000ms、5ms 轮询。
//
// 为什么从 3000ms 提到 15000ms：这个上限只在「一直等不到条件」时才花钱（命中就立即返回），
// 而四路全量并行时 CPU 被压满，原先按单跑定的 3 秒会偶发超时——那是机器慢，不是断言错。
// 把上限放宽不会让断言变松：条件仍要真的成立，只是愿意多等一会儿。
//
// TEST_WAIT_MS 覆盖默认值：排查时临时收紧（比如设 500 看哪里慢）或放宽（比如设 60000），
// 非法值（空串、负数、非数字）退回默认，不让一个环境变量把测试变成永远超时或永远通过。
const DEFAULT_WAIT_MS = 15000;
const POLL_MS = 5;

/** 读 TEST_WAIT_MS；只接受正数毫秒。 */
export const waitLimit = (env = process.env) => {
  const value = Number(env?.TEST_WAIT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WAIT_MS;
};

/**
 * 轮询直到条件成立；超时抛错（错误里带 label，失败时能看出在等什么）。
 *
 * @param {() => boolean} fn 条件；抛错按「还没成立」继续等
 * @param {string} label 超时报错用语
 * @param {number} [ms] 本次上限；缺省读 TEST_WAIT_MS，再缺省 15000ms
 */
export const waitFor = (fn, label, ms = waitLimit()) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    try {
      if (fn()) {
        clearInterval(timer);
        resolve();
        return;
      }
    } catch {
      // 条件还没成立：继续等。
    }
    if (Date.now() - started > ms) {
      clearInterval(timer);
      reject(new Error(`waitFor timeout: ${label}`));
    }
  }, POLL_MS);
});
