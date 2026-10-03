# Fixed Claim Saathi demo document pack. Deterministic: same bytes on every run (PYTHONHASHSEED=0, reportlab invariant).
from reportlab import rl_config
rl_config.invariant = 1
exec(open("/workspace/claim-saathi/demo-pack-src/common.py").read())
import hashlib, json, zipfile

P_ = dict(name="Rohan Verma", dob="12-03-1991", age=35, gender="Male", phone="+91 99999 99999", email="rohan.verma@claimsaathi.demo",
          addr="B-702, Lakeview Residency, Powai, Mumbai 400076", policy="CS-DEMO-POL-2026", member="SHI-DEMO-0001-01",
          plan="Saathi Family Health Optima (Demo)", si=500000, room=4000, copay=10, start="01-01-2026", end="31-12-2026",
          aadhaar="XXXX XXXX 4821", ip="IP-2026-0924-117", uhid="SUN-UH-558201", adm="24-09-2026", dis="27-09-2026", surg="25-09-2026",
          dr="Dr. Sanjay Kulkarni", drq="MS (General Surgery), Reg. MMC-2009-04417", dx="Acute appendicitis", proc="Laparoscopic appendectomy",
          bill_no="SUN/IPD/2026/04471", bill_date="27-09-2026", rcpt="SUN/RCPT/2026/09815", utr="UPI-627014583190", lab_no="SUN/LAB/2026/33907")
ITEMS = [("Room rent - Single AC room", 3, 5000), ("Nursing charges", 3, 800), ("Surgeon fee - laparoscopic appendectomy", 1, 30000),
         ("Anaesthetist fee", 1, 8000), ("Operation theatre charges", 1, 12000), ("Medicines & IV fluids", 1, 7850),
         ("Surgical consumables", 1, 3600), ("Lab investigations (CBC, CRP, USG abdomen)", 1, 4350), ("Registration & admission charges", 1, 1000)]
TOTAL = sum(q * r for _, q, r in ITEMS)
assert TOTAL == 84200
os.makedirs(OUT, exist_ok=True)
REF = lambda n: Paragraph(f"Document reference: <b>CS-DEMO-DOC-{n:02d}</b> (Claim Saathi fixed demo pack)", SM)
SUN = hhead("SUN", "", "")

def f01(path):
    head = dict(INSURER, right="HEALTH INSURANCE E-CARD", right2=f"Policy {P_['policy']}")
    s = [Paragraph("Health Insurance E-Card", H1), Spacer(1, 4 * mm),
         kv([("Member name", P_["name"]), ("Member ID", P_["member"]), ("Date of birth", P_["dob"]), ("Gender", P_["gender"]),
             ("Relation", "Self (Primary insured)"), ("Policy number", P_["policy"]), ("Plan", P_["plan"]), ("Sum insured", inr(P_["si"]) + " (floater)"),
             ("Valid from", P_["start"]), ("Valid to", P_["end"]), ("Room rent limit", inr(P_["room"]) + " per day"), ("Co-payment", f"{P_['copay']}% on every claim"),
             ("TPA", TPA), ("Cashless helpline", "1800-000-0000")]), Spacer(1, 6 * mm),
         Paragraph("Present this card with a photo ID at any network hospital for cashless treatment. Reimbursement claims must be filed within 30 days of discharge.", P),
         Spacer(1, 4 * mm), REF(1)]
    build(path, head, s)

def f02(path):
    head = {"name": "Unique Identification Authority of India (Specimen)", "color": colors.HexColor("#B4441C"),
            "lines": ["Aadhaar - Aam Aadmi ka Adhikar  |  SPECIMEN FOR DEMO, NOT A REAL AADHAAR", "Masked copy shared for insurance KYC only"], "right": "AADHAAR (MASKED)", "right2": "e-Aadhaar specimen"}
    s = [Paragraph("Identity Proof - Aadhaar (masked)", H1), Spacer(1, 4 * mm),
         kv([("Name", P_["name"]), ("Aadhaar number", P_["aadhaar"]), ("Date of birth", P_["dob"]), ("Gender", P_["gender"]),
             ("Address", P_["addr"]), ("Mobile", P_["phone"]), ("Issue date", "15-06-2019"), ("Purpose", f"KYC for health claim, policy {P_['policy']}")]),
         Spacer(1, 6 * mm), Paragraph("Only the last four digits are visible. Specimen created for the Claim Saathi demo; it is not issued by UIDAI.", SM), Spacer(1, 4 * mm), REF(2)]
    build(path, head, s)

def f03(path):
    head = dict(INSURER, right="CLAIM FORM - PART A", right2="To be filled by the insured")
    s = [Paragraph("Reimbursement Claim Form (Part A)", H1), Spacer(1, 3 * mm), Paragraph("Section A - Primary insured", H2),
         kv([("Name", P_["name"]), ("Policy number", P_["policy"]), ("Member ID", P_["member"]), ("Mobile", P_["phone"]), ("Email", P_["email"]), ("Address", P_["addr"])]),
         Paragraph("Section B - Patient and hospitalisation", H2),
         kv([("Patient name", P_["name"]), ("Relation", "Self"), ("Age / Gender", f"{P_['age']} / {P_['gender']}"), ("Hospital", H["SUN"]["name"]),
             ("Date of admission", P_["adm"]), ("Date of discharge", P_["dis"]), ("Diagnosis", P_["dx"]), ("Treatment", P_["proc"]),
             ("Admission type", "Emergency"), ("IP number", P_["ip"])]),
         Paragraph("Section C - Claim details", H2),
         kv([("Claim type", "Reimbursement"), ("Total amount claimed", inr(TOTAL)), ("In words", words(TOTAL)), ("Pre/post hospitalisation", "Nil"),
             ("Bank account", "HDFC Bank, XXXX4821, IFSC HDFC0000123"), ("Payee", P_["name"])]),
         Spacer(1, 4 * mm), Paragraph("I declare that the information given above is true and complete.", P),
         Signature(P_["name"], "Signature of the insured, 28-09-2026, Mumbai"), REF(3)]
    build(path, head, s)

def f04(path):
    head = dict(SUN, right="FINAL HOSPITAL BILL", right2=f"Bill No. {P_['bill_no']}")
    rows = [["#", "Particulars", "Qty", "Rate", "Amount"]] + [[i + 1, d, q, inr(r), inr(q * r)] for i, (d, q, r) in enumerate(ITEMS)] + [["", "Total", "", "", inr(TOTAL)]]
    s = [Paragraph("Final Hospital Bill (In-patient)", H1), Spacer(1, 3 * mm),
         kv([("Patient name", P_["name"]), ("UHID", P_["uhid"]), ("Age / Gender", f"{P_['age']} / {P_['gender']}"), ("IP number", P_["ip"]),
             ("Admission", P_["adm"]), ("Discharge", P_["dis"]), ("Bill date", P_["bill_date"]), ("Room", "Single AC room, 3 days"),
             ("Consultant", P_["dr"]), ("Payer", f"Self (reimbursement), policy {P_['policy']}")]), Spacer(1, 4 * mm),
         grid(rows, [10 * mm, 88 * mm, 14 * mm, 28 * mm, 34 * mm], total_rows=1), Spacer(1, 3 * mm),
         Paragraph(f"Amount payable: <b>{inr(TOTAL)}</b> ({words(TOTAL)}). Paid in full by the patient, see receipt {P_['rcpt']}.", P),
         Signature("Priya Nair", "Billing Executive", stamp=H["SUN"]["name"]), REF(4)]
    build(path, head, s)

def f05(path):
    head = dict(SUN, right="DISCHARGE SUMMARY", right2=f"IP No. {P_['ip']}")
    s = [Paragraph("Discharge Summary", H1), Spacer(1, 3 * mm),
         kv([("Patient name", P_["name"]), ("UHID", P_["uhid"]), ("Age / Gender", f"{P_['age']} / {P_['gender']}"), ("IP number", P_["ip"]),
             ("Date of admission", P_["adm"]), ("Date of discharge", P_["dis"]), ("Consultant", P_["dr"]), ("Department", "General Surgery")]),
         Paragraph("Diagnosis", H2), Paragraph(f"{P_['dx']} (ICD-10 K35.8)", P),
         Paragraph("Presenting complaints", H2), Paragraph("Pain in the right lower abdomen for 1 day, fever and vomiting. Tenderness at McBurney's point.", P),
         Paragraph("Investigations", H2), Paragraph("CBC: total WBC 14,800 /cu mm (raised). CRP 48 mg/L. USG abdomen: inflamed, non-compressible appendix 9 mm. See lab report " + P_["lab_no"] + ".", P),
         Paragraph("Procedure", H2), Paragraph(f"{P_['proc']} under general anaesthesia on {P_['surg']}. Uneventful recovery.", P),
         Paragraph("Condition at discharge", H2), Paragraph("Stable, afebrile, tolerating oral diet, wound healthy.", P),
         Paragraph("Advice", H2), Paragraph("Tab. Amoxicillin-Clavulanate 625 mg twice daily for 5 days. Tab. Paracetamol 650 mg as needed. Review in OPD after 7 days.", P),
         Signature(P_["dr"], P_["drq"], stamp=H["SUN"]["name"]), REF(5)]
    build(path, head, s)

def f06(path):
    head = dict(SUN, right="LABORATORY REPORT", right2=f"Lab No. {P_['lab_no']}")
    rows = [["Test", "Result", "Unit", "Reference range"], ["Haemoglobin", "13.9", "g/dL", "13.0 - 17.0"], ["Total WBC count", "14,800 (H)", "/cu mm", "4,000 - 11,000"],
            ["Neutrophils", "82 (H)", "%", "40 - 75"], ["Platelet count", "2.6", "lakh/cu mm", "1.5 - 4.1"], ["C-reactive protein (CRP)", "48 (H)", "mg/L", "< 6"],
            ["USG abdomen", "Inflamed non-compressible appendix, 9 mm", "", "Appendix < 6 mm"]]
    s = [Paragraph("Laboratory & Imaging Report", H1), Spacer(1, 3 * mm),
         kv([("Patient name", P_["name"]), ("UHID", P_["uhid"]), ("Age / Gender", f"{P_['age']} / {P_['gender']}"), ("Referred by", P_["dr"]),
             ("Sample collected", P_["adm"] + " 10:40"), ("Reported", P_["adm"] + " 13:15")]), Spacer(1, 4 * mm),
         grid(rows, [52 * mm, 50 * mm, 26 * mm, 46 * mm]), Spacer(1, 3 * mm), Paragraph("Impression: findings consistent with acute appendicitis.", PB),
         Signature("Dr. Meera Iyer", "MD (Pathology), Reg. MMC-2011-07752", stamp=H["SUN"]["name"]), REF(6)]
    build(path, head, s)

def f07(path):
    head = dict(SUN, right="PAYMENT RECEIPT", right2=f"Receipt No. {P_['rcpt']}")
    s = [Paragraph("Payment Receipt", H1), Spacer(1, 3 * mm),
         kv([("Received from", P_["name"]), ("Patient", P_["name"]), ("UHID", P_["uhid"]), ("IP number", P_["ip"]), ("Against bill", P_["bill_no"]),
             ("Receipt date", P_["bill_date"]), ("Amount received", inr(TOTAL)), ("In words", words(TOTAL)), ("Mode", "UPI"), ("Transaction ref", P_["utr"])]),
         Spacer(1, 4 * mm), Paragraph(f"Received with thanks Rs. {TOTAL:,} towards the final in-patient bill. Balance due: nil.".replace(",", ","), P),
         Signature("Priya Nair", "Cashier", stamp=H["SUN"]["name"]), REF(7)]
    build(path, head, s)

FILES = [("01_Health_Card.pdf", f01), ("02_ID_Proof_Aadhaar.pdf", f02), ("03_Claim_Form.pdf", f03), ("04_Hospital_Bill.pdf", f04),
         ("05_Discharge_Summary.pdf", f05), ("06_Lab_Report.pdf", f06), ("07_Payment_Receipt.pdf", f07)]
hashes = {}
for name, fn in FILES:
    random.seed(7); p = os.path.join(OUT, name); fn(p); hashes[name] = hashlib.sha256(open(p, "rb").read()).hexdigest()
open(os.path.join(OUT, "README.txt"), "w").write(
    "Claim Saathi fixed demo document pack\n\nLogin in the app with phone 9999999999 and OTP 111000 (Rohan Verma, policy CS-DEMO-POL-2026).\n"
    "Create a reimbursement claim at Sunrise Multispeciality Hospital, then upload these files in order:\n\n" +
    "\n".join(f"  {n}" for n, _ in FILES) + "\n\nSHA-256:\n" + "\n".join(f"  {h}  {n}" for n, h in hashes.items()) + "\n")
json.dump(hashes, open("/workspace/claim-saathi/demo-pack-src/hashes.json", "w"), indent=1)
zp = "/workspace/claim-saathi/demo-pack.zip"
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for n in [f for f, _ in FILES] + ["README.txt"]:
        zi = zipfile.ZipInfo("demo-pack/" + n, date_time=(2026, 9, 28, 12, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, open(os.path.join(OUT, n), "rb").read())
print(json.dumps(hashes, indent=1))
