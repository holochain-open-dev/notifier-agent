import { AdminWebsocket, AppWebsocket, CellType } from "@holochain/client";
import fs from 'fs/promises';
import { send } from "vite";
import { scheduleJob } from "node-schedule";
// import { list } from "pm2";

// ==============SCHEDULING================
async function cronJobNotify(agent_pubKey, message) {
  console.log('cron job notify')
  console.log('agent_pubKey', agent_pubKey)
  let contacts = await getContacts(agent_pubKey);
  console.log('contacts', contacts)
  let contact = contacts[0]
  console.log('found contact', contact)
  let hackMessage = message.replace("Coordination activated", "Happening now")
  sendText(contact.text_number, hackMessage);
  sendEmail(contact.email_address, hackMessage);
  console.log('sending message to', agent_pubKey, contact)
}
// ==============SCHEDULING ENDS================

console.log("starting notifier")
const adminWs = await AdminWebsocket.connect({
  url: "ws://127.0.0.1:18929",
  wsClientOptions: { origin: "hc_sandbox" },
}).then((adminWs) => {
  console.log("here is admin websocket", adminWs)
  return adminWs;
}).catch((e) => {console.log("error", e)});
console.log("connected to admin interface")
let x = await adminWs.agentInfo({wsClientOptions: { origin: "hc_sandbox" }});
console.log("agent info", x)
console.log("------------------------")
let l = await adminWs.listCellIds();
console.log("list of cell ids", l)
let cell_id = l[0];
console.log("cell", cell_id)
let tokenResp = await adminWs.issueAppAuthenticationToken({
  installed_app_id: "myApp1234",
});
const params = { url: "ws://127.0.0.1:17183" };
await adminWs.authorizeSigningCredentials(cell_id);
console.log('connecting now')
const appWs = await AppWebsocket.connect({url: "ws://127.0.0.1:17183", token: tokenResp.token, wsClientOptions: { origin: "hc_sandbox" }});

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
  console.log('sending whatsapp message')
  console.log(to, message, config.twilio.account_sid, config.twilio.auth_token, config.twilio.from_number_whatsapp)
  try {
    fetch('https://api.twilio.com/2010-04-01/Accounts/' + config.twilio.account_sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(config.twilio.account_sid + ':' + config.twilio.whatsapp_auth_token),
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
    form.append('to', to);
    form.append('to', config.mailgun.email_address);
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

async function getContacts(key) {
  try {
    let contacts = await appWs.callZome({
      cell_id,
      zome_name: "notifications",
      fn_name: "get_contacts",
      payload: [key],
    });
    console.log("contacts", contacts)
    return contacts
  } catch(e) {
    console.log("couldn't get contacts", e)
  }
}

let signalCb;
const signalReceived = new Promise((resolve) => {
  signalCb = (signal) => {
      try {
        if (signal.zome_name === 'notifications') {
          console.log('signal received from notifications')
          console.log(signal.payload)
          // console.log(signal.payload.destination)
          // console.log(signal)

          if (signal.payload.destination && signal.payload.destination == "notifier_service") {
            if (signal.payload.status === 'retry' && signal.payload.retry_count < 8) {
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
              console.log("signal.payload")
              let textMessage = signal.payload.message
              for (let i = 0; i < signal.payload.contacts.length; i++) {
                let contact = signal.payload.contacts[i]

                if (signal.payload.delay_until) {
                  // If delay, schedule job
                  console.log('delaying message')
                  try {
                    console.log("scheduling job")
                    // let tenSecondsLater = new Date(new Date().getTime() + 10000); // 10000 milliseconds = 10 seconds
                    let date = new Date(signal.payload.delay_until / 1000);
                    console.log("delayed until" + date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate() + " " + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds())
                    scheduleJob(date, function() {
                      console.log('running job')
                      cronJobNotify(signal.payload.contacts[i].agent_pub_key, signal.payload.message);
                    }); 
                  } catch (error) {
                    console.error('Error scheduling cron job:', error);
                  }
                } else {
                  // If no delay, send message immediately
                  try {
                    if (contact.text_number.length > 0) {
                      console.log('sending text')
                      sendText(contact.text_number, textMessage)
                    }
                    if (contact.email.length > 0) {
                      console.log('sending email')
                      sendEmail(contact.email, textMessage)
                    }
                    if (contact.whatsapp_number.length > 0) {
                      console.log('sending whatsapp message')
                      sendWhatsappMessage(contact.whatsapp_number, textMessage)
                    }
                  } catch(e) {
                    console.log('error sending message', e)
                  }
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

await appWs.callZome({
  cell_id,
  zome_name: "notifications",
  fn_name: "claim_notifier",
  // provenance: agent_key,
  payload: "Official notifier service 3",
});

const notifiers = await appWs.callZome({
  cell_id,
  zome_name: "notifications",
  fn_name: "list_notifiers",
  payload: null,
});

let am_i_in_notifiers = notifiers.find(n => JSON.stringify(n.agent) == JSON.stringify(appWs.myPubKey));

console.log("notifiers", am_i_in_notifiers)

// if (!am_i_in_notifiers) {
  await appWs.callZome({
    cell_id,
    zome_name: "notifications",
    fn_name: "create_twilio_credentials",
    payload: {
      account_sid: config.twilio.account_sid,
      auth_token: config.twilio.auth_token,      
      from_number_text: config.twilio.from_number_text,
      from_number_whatsapp: config.twilio.from_number_whatsapp
    },
  });
// }

await signalReceived;