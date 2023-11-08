import { AdminWebsocket, AppWebsocket, CellType } from "@holochain/client";
import fs from 'fs/promises';

const adminWs = await AdminWebsocket.connect("ws://127.0.0.1:18929");
let cell_id;
let l = await adminWs.listCellIds();
cell_id = l[0];
console.log("cell", cell_id)
await adminWs.authorizeSigningCredentials(cell_id);
console.log('connecting now')
const appWs = await AppWebsocket.connect("ws://127.0.0.1:17183");

console.log("app info", JSON.stringify(appWs.appInfo))

async function dnaHash() {
  try {
    let s = await appWs.callZome({
      cell_id,
      zome_name: "coordinator",
      fn_name: "get_dna_hash",
      payload: null,
    }).catch((z) => {
      console.log("dna hash:")
      console.log(z)
    })
    console.log(s)
  } catch(e) {
    console.log("couldn't get dna hash", e)
  }
}

console.log("retrieving dna hash")
await dnaHash();

async function readConfigFile() {
  try {
    const data = await fs.readFile('config.json', 'utf8');
    const config = JSON.parse(data);
    return config;
  } catch (err) {
    console.error('Error reading or parsing config file:', err);
  }
}
let config = await readConfigFile();
console.log(config)

console.log('starting up')

async function sendText(to, message) {
  console.log(to, message, config.twilio.account_sid, config.twilio.auth_token, config.twilio.from_number_text)
  try {
    fetch('https://api.twilio.com/2010-04-01/Accounts/' + config.twilio.account_sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(config.twilio.account_sid + ':' + config.twilio.auth_token),
      },
      body: new URLSearchParams({
        'To': "+" + to,
        'From': "+" + config.twilio.from_number_text,
        'Body': message
      })
    });
  } catch {
    console.log('error sending text')
  }
}

async function sendWhatsappMessage(to, message) {
  console.log(to, message, config.twilio.account_sid, config.twilio.auth_token, config.twilio.from_number_whatsapp)
  try {
    fetch('https://api.twilio.com/2010-04-01/Accounts/' + config.twilio.account_sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(config.twilio.account_sid + ':' + config.twilio.auth_token),
      },
      body: new URLSearchParams({
        'To':'whatsapp:+' + to,
        'From': 'whatsapp:+' + config.twilio.from_number_whatsapp,
        'Body': message
      })
    });
  } catch {
    console.log('error sending Whatsapp message')
  }
}

async function sendEmail(to, message) {
  try {
    const form = new FormData();
    form.append('from', 'Excited User <' + config.mailgun.email_address + '>');
    form.append('to', config.mailgun.email_address);
    form.append('to', to);
    form.append('subject', 'New message');
    form.append('text', message);

    fetch('https://api.mailgun.net/v3/' + config.mailgun.domain + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(config.mailgun.auth_token)
      },
      body: form
    });

  } catch {
    console.log('error sending email')
  }
}

let signalCb;
const signalReceived = new Promise((resolve) => {
  signalCb = (signal) => {
      try {
        if (signal.zome_name === 'notifications') {
          console.log('signal received from notifications')
          console.log(signal.payload)

          if (signal.payload.destination && signal.payload.destination == "notifier_service") {
            if (signal.payload.status === 'retry' && signal.payload.retry_count < 5) {
              console.log('about to retry')
              let new_payload = signal.payload;
              new_payload.retry_count = new_payload.retry_count + 1
              console.log(new_payload)
              setTimeout(() => {
                appWs.callZome({
                  cell_id,
                  zome_name: "notifications",
                  fn_name: "handle_notification_tip",
                  payload: new_payload,
                });
              }, 10000);
            } else {
              console.log('sending text')
              console.log(signal.payload)
              let textMessage = signal.payload.message
              for (let i = 0; i < signal.payload.contacts.length; i++) {
                let contact = signal.payload.contacts[i]
                if (contact.text_number.length > 0) {
                  sendText(contact.text_number, textMessage)
                }
                if (contact.email.length > 0) {
                  sendEmail(contact.email, textMessage)
                }
                if (contact.whatsapp_number.length > 0) {
                  sendWhatsappMessage(contact.whatsapp_number, textMessage)
                }
              }
            }
          }
        }
      } catch (e) {
        console.log(e.data)
      }
    
    resolve();
  };
});
appWs.on("signal", signalCb);

sendEmail('test', 'test email')

await appWs.callZome({
  cell_id,
  zome_name: "notifications",
  fn_name: "claim_notifier",
  // provenance: agent_key,
  payload: "Official notifier service",
});

await appWs.callZome({
  cell_id,
  zome_name: "notifications",
  fn_name: "create_twilio_credentials",
  payload: {
    account_sid: config.twilio.account_sid,
    auth_token: config.twilio.auth_token,
    // from_number: config.twilio.from_number_text,

    from_number_text: config.twilio.from_number_text,
    from_number_whatsapp: config.twilio.from_number_whatsapp
  },
});
await signalReceived;

