import requests
import smtplib
import imaplib
import email
from email.mime.text import MIMEText
from email.header import decode_header
import time
from datetime import datetime

RAILWAY_API_URL = "https://your-app-name.up.railway.app/api/agent"

def get_job():
    try:
        return requests.get(f"{RAILWAY_API_URL}/get-job").json().get('job')
    except: return None

def send_email(job):
    try:
        msg = MIMEText(job['body'])
        msg['Subject'] = job['subject']
        msg['From'] = job['gmail_user']
        msg['To'] = job['to_email']
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(job['gmail_user'], job['gmail_pass'])
            server.sendmail(job['gmail_user'], job['to_email'], msg.as_string())
        print(f"✅ मेल भेजा गया: {job['to_email']} को")
        return 'sent'
    except Exception as e:
        print(f"❌ एरर: {e}")
        return 'failed'

def update_job(lead_id, campaign_id, gmail_user, status):
    requests.post(f"{RAILWAY_API_URL}/update-job", json={"lead_id": lead_id, "campaign_id": campaign_id, "gmail_user": gmail_user, "status": status})

def check_replies(gmail_user, gmail_pass):
    try:
        mail = imaplib.IMAP4_SSL('imap.gmail.com')
        mail.login(gmail_user, gmail_pass)
        mail.select('inbox')
        date = (datetime.now()).strftime("%d-%b-%Y")
        _, data = mail.search(None, f'(SINCE {date})')
        for num in data[0].split():
            _, msg_data = mail.fetch(num, '(RFC822)')
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject = decode_header(msg["Subject"])[0][0]
                    if isinstance(subject, bytes): subject = subject.decode()
                    from_email = msg.get("From")
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain": body = part.get_payload(decode=True).decode(); break
                    else: body = msg.get_payload(decode=True).decode()
                    payload = {"from_email": from_email, "to_email": gmail_user, "subject": subject, "body": body[:500]}
                    requests.post(f"{RAILWAY_API_URL}/submit-reply", json=payload)
                    print(f"💬 नया रिप्लाई मिला: {from_email} से")
        mail.logout()
    except Exception as e: print(f"IMAP एरर: {e}")

def get_manual_job():
    try: return requests.get(f"{RAILWAY_API_URL}/get-manual-job").json().get('job')
    except: return None

def execute_manual_job(job):
    try:
        msg = MIMEText(job['body'])
        msg['Subject'] = job['subject']
        msg['From'] = job['from_email']
        msg['To'] = job['to_email']
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(job['from_email'], job['from_pass'])
            server.sendmail(job['from_email'], job['to_email'], msg.as_string())
        print(f"📤 Manual Action: {job['from_email']} से {job['to_email']} को मेल भेज दिया गया!")
        return 'done'
    except Exception as e:
        print(f"Manual Action एरर: {e}")
        return 'failed'

def update_manual_job(job_id, status):
    requests.post(f"{RAILWAY_API_URL}/update-manual-job", json={"job_id": job_id, "status": status})

def do_warmup():
    try:
        res = requests.get(f"{RAILWAY_API_URL}/get-warmup-job")
        job = res.json().get('job')
        if not job: return False
        sender = job['sender']; receiver = job['receiver']; subject = job['subject']; body = job['body']
        msg = MIMEText(body); msg['Subject'] = subject; msg['From'] = sender['email']; msg['To'] = receiver['email']
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(sender['email'], sender['pass'])
            server.sendmail(sender['email'], receiver['email'], msg.as_string())
        print(f"🔥 Warmup: {sender['email']} ने मेल भेजा -> {receiver['email']} को")
        time.sleep(15)
        mail = imaplib.IMAP4_SSL('imap.gmail.com'); mail.login(receiver['email'], receiver['pass']); mail.select('inbox')
        _, data = mail.search(None, f'(FROM "{sender['email']}")')
        mail_ids = data[0].split()
        if mail_ids:
            latest_id = mail_ids[-1]; mail.store(latest_id, '+FLAGS', '\Seen')
            replies = ["Sounds great! Thanks.", "Got it, appreciate it.", "Let's discuss tomorrow.", "Perfect, thanks!"]
            reply_body = replies[int(time.time()) % len(replies)]
            reply_msg = MIMEText(reply_body); reply_msg['Subject'] = "Re: " + subject; reply_msg['From'] = receiver['email']; reply_msg['To'] = sender['email']
            with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp_server:
                smtp_server.login(receiver['email'], receiver['pass'])
                smtp_server.sendmail(receiver['email'], sender['email'], reply_msg.as_string())
            print(f"🔥 Warmup: {receiver['email']} ने अपने आप रिप्लाई भेज दिया -> {sender['email']} को")
            requests.post(f"{RAILWAY_API_URL}/update-warmup-job", json={"thread_id": job['thread_id'], "status": "done"})
            mail.logout(); return True
        else:
            requests.post(f"{RAILWAY_API_URL}/update-warmup-job", json={"thread_id": job['thread_id'], "status": "failed"}); mail.logout()
    except Exception as e: print(f"Warmup एरर: {e}")
    return False

if __name__ == "__main__":
    print("🚀 Python Agent चल रहा है...")
    warmup_counter = 0
    while True:
        manual_job = get_manual_job()
        if manual_job:
            status = execute_manual_job(manual_job)
            update_manual_job(manual_job['job_id'], status)
            time.sleep(5); continue

        if warmup_counter < 3:
            job = get_job()
            if job:
                status = send_email(job)
                update_job(job['lead_id'], job['campaign_id'], job['gmail_user'], status)
                if status == 'sent': check_replies(job['gmail_user'], job['gmail_pass'])
                time.sleep(30); warmup_counter += 1
            else:
                do_warmup(); time.sleep(60)
        else:
            print("🔄 3 मेल पूरे हुए, अब 1 वार्मअप कर रहे हैं...")
            do_warmup(); warmup_counter = 0; time.sleep(10)
