const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const { join } = require("path");
const fs = require("fs");
const getNpmRegistry = require("getnpmregistry");
const execa = require("execa");
const { kill } = require("cross-port-killer");
const ora = require("ora");
const portAvailable = require("./portAvailable");
const PNGImage = require("pngjs-image");
const diffPng = require("./diff");
const spinner = ora();

const env = Object.create(process.env);
env.BROWSER = "none";
env.PORT = process.env.PORT || "2144";
env.TEST = true;
env.COMPRESS = "none";
env.PROGRESS = "none";
env.BLOCK_PAGES_LAYOUT = "blankLayout";

let browser;

let diffFile = [];

/**
 * 启动区块服务
 * @param {string} path
 */
const startServer = async path => {
  let once = false;
  return new Promise(resolve => {
    env.PAGES_PATH = `${path}/src`;

    const startServer = spawn(
      /^win/.test(process.platform) ? "npm.cmd" : "npm",
      ["run", "start"],
      {
        env
      }
    );
    startServer.stdout.on("data", data => {
      // hack code , wait umi
      if (!once && data.toString().indexOf("Compiled successfully") >= 0) {
        // eslint-disable-next-line
        once = true;
        return resolve(startServer);
      }
    });
    startServer.on("exit", () => {
      kill(env.PORT || 8000);
    });
  });
};

const autoScroll = page =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        let totalHeight = 0;
        const distance = 100;
        var timer = setInterval(() => {
          const { scrollHeight } = document.body;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      })
  );

const readPng = path => {
  return new Promise((resolve, reject) => {
    PNGImage.readImage(path, (error, image) => {
      if (error) {
        reject(error);
      }
      resolve(image);
    });
  });
};

const getImage = async (page, path, diff) => {
  try {
    const isAvailable = await portAvailable(8000);
    if (!isAvailable) {
      kill(env.PORT || 8000);
    }
  } catch (error) {
    console.log(error);
  }
  const server = await startServer(path);
  await page.goto(`http://127.0.0.1:${env.PORT}`);

  await page.setViewport({
    width: 1440,
    height: 800
  });
  await autoScroll(page);
  const imagePath = join(path, "snapshot.png");
  let png = null;
  if (diff) {
    png = await readPng(imagePath);
  }

  await page.screenshot({
    path: imagePath,
    fullPage: true
  });

  if (diff) {
    const diffPngPath = join(path, "diff.png");
    spinner.start("diff png");
    const isDiff = await diffPng(png, imagePath, diffPngPath);
    if (!isDiff) {
      diffFile.push(path);
    } else {
      fs.unlinkSync(diffPngPath);
    }
    spinner.succeed();
  }

  server.kill();
};

const openBrowser = async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-zygote",
      "--no-sandbox"
    ]
  });
  const page = await browser.newPage();
  return page;
};

/**
 * 取得所有区块
 */
const getAllFile = async cwd => {
  const files = fs.readdirSync(cwd);

  return files.filter(path => {
    const itemPath = join(cwd, path);
    const stat = fs.statSync(itemPath);
    if (
      path.includes(".") ||
      path.includes("_") ||
      path.includes("node_modules")
    ) {
      return false;
    }
    if (stat.isDirectory()) {
      const havePackage = fs.existsSync(join(itemPath, "package.json"));

      if (havePackage) {
        return true;
      }
    }
    return false;
  });
};

module.exports = async ({ cwd, diff }) => {
  diffFile = [];
  spinner.start("🔍  Get all block");
  const dirList = await getAllFile(cwd);
  spinner.succeed();

  const total = dirList.length;
  spinner.start("🌏  start puppeteer");
  const registry = await getNpmRegistry();
  const page = await openBrowser();
  spinner.succeed();

  const loopGetImage = async index => {
    try {
      spinner.start(`📦  install ${dirList[index]} dependencies`);
      await execa("yarn", ["install", `--registry=${registry}`, "--force"], {
        cwd: join(cwd, `./${dirList[index]}`)
      });
      spinner.succeed();

      spinner.start(`📷  snapshot block image  (${index + 1}/${total})`);
      await getImage(page, dirList[index], diff);
      spinner.succeed();

      if (dirList.length > index && dirList[index + 1]) {
        return loopGetImage(index + 1);
      }
    } catch (error) {
      console.log(error);
    }
    return Promise.resolve(true);
  };
  await loopGetImage(0);

  if (diffFile.length > 0) {
    console.log(`diff 结束，共有 ${diffFile.length} 未通过检查。`);
  }

  browser.close();
  return diffFile;
};
