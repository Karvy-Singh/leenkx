module.exports = {
  apps: [
    {
      name: 'unreplied-links',
      script: './server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
