"""Create typography/step overlays only. Screenshots are never opened or redrawn here."""
import sys, json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out=Path(sys.argv[1]); out.mkdir(parents=True,exist_ok=True)
navy='#0c1b30'; gold='#a78044'; muted='#637084'; line='#d9d1c2'
fontdir=Path('/System/Library/Fonts/Supplemental')
def font(size,bold=False,serif=False):
 return ImageFont.truetype(str(fontdir/('Georgia.ttf' if serif else 'Arial Bold.ttf' if bold else 'Arial.ttf')),size)
def wrapped(draw,text,xy,maxw,size=23,color=muted):
 x,y=xy; f=font(size); row=''
 for word in text.split():
  candidate=(row+' '+word).strip()
  if draw.textlength(candidate,font=f)>maxw and row:
   draw.text((x,y),row,font=f,fill=color); y+=34; row=word
  else: row=candidate
 draw.text((x,y),row,font=f,fill=color)
steps=[
 ('Get the extension','Download the ZIP, then extract it.','Download & extract'),
 ('Developer mode','Open chrome://extensions and enable the switch at the top right.','Enable Developer mode'),
 ('Load unpacked','Use the button at the top left.','Load unpacked'),
 ('Select the folder','Choose troia-testnet, then click Select. Keep this folder on your computer.','Select troia-testnet'),
 ('Check installation','Troia appears in Chrome. Leave its switch enabled.','Check Troia'),
 ('Open Troia','Open Troia from the extensions menu. Your setup is complete.','Ready to use'),
]
for i,(title,desc,_) in enumerate(steps):
 im=Image.new('RGBA',(1600,900),(0,0,0,0)); d=ImageDraw.Draw(im)
 d.text((64,40),'T R O I A',font=font(27,serif=True),fill=navy)
 d.text((1250,49),'CHROME / QUICK SETUP',font=font(14),fill=muted)
 d.line((64,98,1536,98),fill=line,width=1)
 d.text((64,143),f'0{i+1} / 06',font=font(17,bold=True),fill=gold)
 wrapped(d,title,(64,190),400,size=38,color=navy)
 wrapped(d,desc,(64,305),380,size=23)
 for j,(_,_,label) in enumerate(steps):
  y=480+j*42
  d.ellipse((65,y+5,73,y+13),fill=gold if j==i else line)
  d.text((90,y),label,font=font(17,bold=j==i),fill=navy if j==i else muted)
 d.rounded_rectangle((509,153,1537,787),radius=3,outline=line,width=1)
 d.text((64,834),'DESKTOP CHROME',font=font(13),fill=muted)
 d.text((1320,834),'STELLAR TESTNET',font=font(13),fill=muted)
 for j in range(6):
  x=620+j*59
  d.rounded_rectangle((x,844,x+43,847),radius=1,fill=gold if j<=i else line)
 im.save(out/f'overlay-{i}.png')
print('Typography overlays ready')
