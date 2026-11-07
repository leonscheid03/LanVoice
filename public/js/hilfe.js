// Der Weiter-Button zeigt auf dieselbe Adresse, aber mit https:// (Inline-Skripte verbietet die CSP).
document.getElementById('go').href = `https://${location.host}/`;
