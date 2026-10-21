module.exports = {
  apps: [
    {
      name: 'rswater-api',
      script: 'src/server.js',
      cwd: '/var/www/rswater-api/backend',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
        HOST: '0.0.0.0',
      },
    },
  ],
};
