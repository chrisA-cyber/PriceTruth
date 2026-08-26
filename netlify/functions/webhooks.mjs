import appHandler from './app.mjs';

const config = {
  path: ['/api/billing/webhook', '/api/email/webhook'],
  method: 'POST',
};

export default appHandler;
export { config };
