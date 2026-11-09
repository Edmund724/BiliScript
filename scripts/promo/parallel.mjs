import os from "node:os";

export function availableCpus() {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

// 返回一个排队函数：同时最多执行 limit 个任务，其余按提交顺序等待空位。
export function createLimiter(limit) {
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      job.run().then(job.resolve, job.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (run) =>
    new Promise((resolve, reject) => {
      queue.push({run, resolve, reject});
      drain();
    });
}
