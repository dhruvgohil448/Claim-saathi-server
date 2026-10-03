import os, csv, math, random, subprocess, shutil
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, KeepTogether)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_RIGHT

F="/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("DV",F+"DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DVB",F+"DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DVS",F+"DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("DVSB",F+"DejaVuSerif-Bold.ttf"))
pdfmetrics.registerFont(TTFont("MONO",F+"DejaVuSansMono.ttf"))
random.seed(7)
OUT="/workspace/claim-saathi/demo-pack"
shutil.rmtree(OUT,ignore_errors=True); os.makedirs(OUT)
PW,PH=A4
NAVY=colors.HexColor("#002E6E"); BLUE=colors.HexColor("#00BAF2"); GREY=colors.HexColor("#5B6B7F")
ss=lambda **k: ParagraphStyle("x",fontName=k.pop("fn","DV"),fontSize=k.pop("fs",9),leading=k.pop("ld",12.5),**k)
P=ss(); PB=ss(fn="DVB"); SM=ss(fs=7.5,ld=10,textColor=GREY); H1=ss(fn="DVB",fs=14,ld=18,textColor=NAVY,alignment=TA_CENTER)
H2=ss(fn="DVB",fs=10,ld=14,textColor=NAVY,spaceBefore=6,spaceAfter=2); R=ss(alignment=TA_RIGHT); RB=ss(fn="DVB",alignment=TA_RIGHT)

def inr(n):
    n=round(n); s=str(abs(n)); 
    if len(s)>3:
        h,t=s[:-3],s[-3:]; g=[]
        while len(h)>2: g.insert(0,h[-2:]); h=h[:-2]
        if h: g.insert(0,h)
        s=",".join(g)+","+t
    return ("-" if n<0 else "")+"₹"+s

def words(n):
    ones="zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
    tens="  twenty thirty forty fifty sixty seventy eighty ninety".split(" ")
    def two(x): return ones[x] if x<20 else tens[x//10]+("" if x%10==0 else "-"+ones[x%10])
    def three(x): return (ones[x//100]+" hundred"+(" and "+two(x%100) if x%100 else "")) if x>=100 else two(x)
    n=int(round(n)); parts=[]
    for div,name in ((10**7,"crore"),(10**5,"lakh"),(1000,"thousand")):
        if n>=div: parts.append(three(n//div)+" "+name); n%=div
    if n: parts.append(three(n))
    return ("Rupees "+" ".join(parts)+" only").capitalize()

# ---------- page decorations ----------
def deco(header):
    def f(c,doc):
        c.saveState()
        c.setFillColor(header["color"]); c.rect(0,PH-6*mm,PW,6*mm,stroke=0,fill=1)
        c.setFillColor(header["color"]); c.setFont("DVB",15); c.drawString(18*mm,PH-17*mm,header["name"])
        c.setFillColor(GREY); c.setFont("DV",7.5)
        y=PH-21.5*mm
        for line in header["lines"]:
            c.drawString(18*mm,y,line); y-=3.4*mm
        if header.get("right"):
            c.setFont("DVB",8.5); c.setFillColor(NAVY); c.drawRightString(PW-18*mm,PH-17*mm,header["right"])
            c.setFont("DV",7.5); c.setFillColor(GREY); c.drawRightString(PW-18*mm,PH-21.5*mm,header.get("right2",""))
        c.setStrokeColor(header["color"]); c.setLineWidth(0.8); c.line(18*mm,PH-33*mm,PW-18*mm,PH-33*mm)
        c.setFont("DV",6.5); c.setFillColor(GREY)
        c.drawString(18*mm,10*mm,"Fictional sample generated for Team Fear Fighters (Claim Saathi, Paytm Hackathon). Not a real medical or insurance record.")
        c.drawRightString(PW-18*mm,10*mm,f"Page {doc.page}")
        c.restoreState()
    return f

def wm(c,doc):
    c.saveState(); c.setFillColor(colors.HexColor("#8FA3BF")); c.setFillAlpha(0.13); c.setFont("DVB",40)
    c.translate(PW/2,PH/2); c.rotate(35); c.drawCentredString(0,0,"DUMMY DOCUMENT"); c.setFont("DVB",20); c.drawCentredString(0,-34,"FOR HACKATHON DEMO ONLY"); c.restoreState()

def build(path, header, story):
    doc=BaseDocTemplate(path,pagesize=A4,leftMargin=18*mm,rightMargin=18*mm,topMargin=37*mm,bottomMargin=18*mm,
        title=os.path.basename(path),author="Claim Saathi demo")
    fr=Frame(doc.leftMargin,doc.bottomMargin,doc.width,doc.height,id="f")
    doc.addPageTemplates([PageTemplate(id="p",frames=[fr],onPage=deco(header),onPageEnd=wm)]); doc.build(story)

def kv(rows, cols=2, widths=None):
    data=[]; 
    for i in range(0,len(rows),cols):
        r=[]
        for k,v in rows[i:i+cols]: r+= [Paragraph(k,SM),Paragraph(str(v),PB)]
        while len(r)<cols*2: r+=["",""]
        data.append(r)
    cw = widths or ([28*mm,57*mm]*cols if cols==2 else [40*mm,134*mm])
    t=Table(data,colWidths=cw)
    t.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("BOTTOMPADDING",(0,0),(-1,-1),3),("TOPPADDING",(0,0),(-1,-1),2),
        ("LINEBELOW",(0,0),(-1,-1),0.25,colors.HexColor("#E3E8EF"))])); return t

def grid(data, widths, head_color=NAVY, total_rows=0):
    d=[[Paragraph(str(x),ss(fn="DVB",fs=8,textColor=colors.white)) for x in data[0]]]+[[Paragraph(str(x),ss(fs=8.3,ld=11)) for x in r] for r in data[1:]]
    t=Table(d,colWidths=widths,repeatRows=1)
    st=[("BACKGROUND",(0,0),(-1,0),head_color),("GRID",(0,0),(-1,-1),0.3,colors.HexColor("#C9D3E0")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,colors.HexColor("#F6F9FC")])]
    if total_rows: st+=[("BACKGROUND",(0,-total_rows),(-1,-1),colors.HexColor("#E8F7FD"))]
    t.setStyle(TableStyle(st)); return t

class Sign:  # flowable-ish via table cell drawing
    pass
from reportlab.platypus import Flowable
class Signature(Flowable):
    def __init__(self, name, title, stamp=None, w=60*mm): super().__init__(); self.name,self.title,self.stamp,self.w=name,title,stamp,w; self.height=26*mm
    def wrap(self,aw,ah): return (self.w,self.height)
    def draw(self):
        c=self.canv; random.seed(hash(self.name)%1000)
        c.setStrokeColor(colors.HexColor("#1B3A8A")); c.setLineWidth(1.1)
        p=c.beginPath(); x,y=4*mm,15*mm; p.moveTo(x,y)
        for i in range(14):
            x+=3*mm; y=15*mm+math.sin(i*1.3)*3*mm+random.uniform(-1.5,1.5)*mm; p.curveTo(x-2*mm,y+3*mm,x-1*mm,y-3*mm,x,y)
        c.drawPath(p)
        c.setStrokeColor(GREY); c.setLineWidth(0.4); c.line(0,10*mm,self.w,10*mm)
        c.setFont("DVB",8); c.setFillColor(colors.black); c.drawString(0,6*mm,self.name)
        c.setFont("DV",7); c.setFillColor(GREY); c.drawString(0,2.5*mm,self.title)
        if self.stamp:
            c.saveState(); c.translate(self.w+14*mm,13*mm); c.rotate(-12)
            c.setStrokeColor(colors.HexColor("#7A2FB5")); c.setFillColor(colors.HexColor("#7A2FB5")); c.setLineWidth(1.2)
            c.circle(0,0,11*mm); c.circle(0,0,8.5*mm); c.setFont("DVB",5.5)
            txt=self.stamp.upper()[:34]
            for i,ch in enumerate(txt):
                a=math.radians(180-i*(180/ max(len(txt)-1,1))); c.saveState(); c.translate(9.6*mm*math.cos(a),9.6*mm*math.sin(a)); c.rotate(math.degrees(a)-90); c.drawCentredString(0,-1,ch); c.restoreState()
            c.setFont("DVB",6.5); c.drawCentredString(0,-1*mm,"VERIFIED"); c.setFont("DV",5); c.drawCentredString(0,-4*mm,"SEAL"); c.restoreState()

# ---------- master data ----------
INSURER={"name":"Saathi Health Insurance Co. Ltd. (Demo)","color":NAVY,
  "lines":["Regd. Office: 7th Floor, Demo Towers, Bandra Kurla Complex, Mumbai 400051  |  IRDAI Reg. No. DEMO-000 (fictional)",
           "Toll-free: 1800-000-0000  |  claims@saathihealth.demo  |  www.saathihealth.demo","CIN: U00000MH2020PLC000000 (fictional)"]}
TPA="Saathi Claims TPA Pvt. Ltd. (Demo)"

H={ # hospitals
 "SUN":dict(name="Sunrise Multispeciality Hospital",addr="Plot 14, Link Road, Andheri West, Mumbai 400053",reg="MH/MUM/HOSP/2016/0412",gst="27AAACS0000A1Z5",ph="022-4000-1100",rohini="8900012345678"),
 "LOT":dict(name="Lotus Care Hospital",addr="Ghodbunder Road, Thane West 400607",reg="MH/THN/HOSP/2014/0227",gst="27AAACL0000B1Z2",ph="022-4111-2200",rohini="8900023456789"),
 "ARO":dict(name="Arogya Ortho & Joint Centre",addr="FC Road, Shivajinagar, Pune 411005",reg="MH/PUN/HOSP/2012/0981",gst="27AAACA0000C1Z9",ph="020-4222-3300",rohini="8900034567890"),
 "SHA":dict(name="Shanti Medical Centre",addr="SV Road, Borivali West, Mumbai 400092",reg="MH/MUM/HOSP/2018/0633",gst="27AAACS1111D1Z4",ph="022-4333-4400",rohini="8900045678901"),
 "CIT":dict(name="CityLife Hospital",addr="Sector 10, Vashi, Navi Mumbai 400703",reg="MH/NMB/HOSP/2015/0154",gst="27AAACC0000E1Z1",ph="022-4444-5500",rohini="8900056789012"),
 "KAM":dict(name="Kamala Maternity & Women's Hospital",addr="Ranade Road, Dadar West, Mumbai 400028",reg="MH/MUM/HOSP/2010/0078",gst="27AAACK0000F1Z8",ph="022-4555-6600",rohini="8900067890123"),
 "DRI":dict(name="Drishti Eye Hospital",addr="LBS Marg, Ghatkopar West, Mumbai 400086",reg="MH/MUM/HOSP/2017/0519",gst="27AAACD0000G1Z6",ph="022-4666-7700",rohini="8900078901234"),
 "HRT":dict(name="HeartLine Cardiac Institute",addr="Hiranandani Gardens, Powai, Mumbai 400076",reg="MH/MUM/HOSP/2013/0301",gst="27AAACH0000H1Z3",ph="022-4777-8800",rohini="8900089012345"),
 "OAK":dict(name="Oakwood General Hospital",addr="Station Road, Kalyan West 421301",reg="MH/THN/HOSP/2019/0712",gst="27AAACO0000J1Z7",ph="0251-400-9900",rohini="8900090123456"),
}
def hhead(k,right,right2=""):
    h=H[k]; return {"name":h["name"],"color":colors.HexColor("#0B6E4F") if k in("SUN","SHA","OAK") else colors.HexColor("#8A1538") if k in("KAM","HRT") else colors.HexColor("#0A5E8C"),
      "lines":[h["addr"]+f"  |  Ph: {h['ph']}",f"Reg. No: {h['reg']}  |  GSTIN: {h['gst']}  |  ROHINI ID: {h['rohini']}","NABH Accredited (fictional)  |  24x7 Emergency & Cashless Desk"],"right":right,"right2":right2}
