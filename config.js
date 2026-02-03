import dotenv from 'dotenv';

dotenv.config();

export default {
  server: {
    port: process.env.PORT || 3005
  },

  auth: {
    username: process.env.CHARIKA_USERNAME || 'H.QOTBI@matu.ma',
    password: process.env.CHARIKA_PASSWORD || 'Houssam@2002'
  },

  scraper: {
    headless: true,
    loginUrl: 'https://www.charika.ma/accueil',
    searchUrlPattern: '**/societe-rechercher**',
    postLoginDelay: 2000,
    minMatchScore: 0.8
  },

  matching: {
    legalNoise: [
      'SOCIETE', 'STE', 'STÉ', 'SARL', 'SA', 'S', 'A', 'R', 'L',
      'COMPAGNIE', 'CIE', 'ET', 'DE', 'DES', 'DU',
      'TRANSPORT', 'TRANS', 'VOYAGE', 'TOURS'
    ]
  }
};  
