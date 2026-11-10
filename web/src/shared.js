export const roles = { admin: 'Administrator', editor: 'Wissensvermittler', user: 'Nutzer' };
export const chatKey = (id) => `wissensraum:chat:${id}`;
export const date = (value) =>
  new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
