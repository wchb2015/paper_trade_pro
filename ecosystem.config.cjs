const ports = require("./ports.cjs");

module.exports = {
  apps: [
    {
      name: `${ports.BACKEND_PORT}_paper-trade-pro-backend`,
      cwd: "./backend",
      script: "dist/backend/src/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        PORT: ports.BACKEND_PORT,
      },
    },
    {
      name: `${ports.FRONTEND_DEV_PORT}_paper-trade-pro-frontend`,
      cwd: "./frontend",
      script: "node_modules/vite/bin/vite.js",
      args: `preview --port ${ports.FRONTEND_DEV_PORT} --strictPort --host`,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
