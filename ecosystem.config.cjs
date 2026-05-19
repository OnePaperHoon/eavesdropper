module.exports = {
  apps: [
    {
      name: 'eavesdropper',
      script: 'src/bot.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/bot-error.log',
      out_file: 'logs/bot-out.log',
    },
  ],
};
