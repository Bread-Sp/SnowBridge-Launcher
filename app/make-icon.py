# 生成托盘图标：深色圆角底 + 青色小鲸鱼 + 气泡，输出多尺寸 .ico
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 先做圆角底板
base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(base)
bd.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(13, 20, 33, 255))

# 顶部微光：只在底板范围内叠加，避免圆角外漏白
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for y in range(0, int(S * 0.55)):
    alpha = int(30 * (1 - y / (S * 0.55)))
    gd.line([(0, y), (S, y)], fill=(56, 132, 255, alpha))
img = Image.alpha_composite(img, base)
img = Image.alpha_composite(img, Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), base.split()[3]))

d = ImageDraw.Draw(img)

# 小鲸鱼身体
d.ellipse([int(S * 0.18), int(S * 0.32), int(S * 0.74), int(S * 0.76)], fill=(126, 224, 255, 255))
# 尾鳍
d.polygon([(int(S * 0.68), int(S * 0.54)), (int(S * 0.90), int(S * 0.33)), (int(S * 0.90), int(S * 0.71))], fill=(126, 224, 255, 255))
# 眼睛
eye = int(S * 0.043)
ex, ey = int(S * 0.58), int(S * 0.47)
d.ellipse([ex - eye, ey - eye, ex + eye, ey + eye], fill=(10, 18, 30, 255))
# 腹部浅色
d.ellipse([int(S * 0.26), int(S * 0.60), int(S * 0.68), int(S * 0.78)], fill=(198, 244, 255, 255))
# 气泡
for (px, py, pr) in [(0.40, 0.24, 0.036), (0.29, 0.15, 0.022), (0.51, 0.15, 0.027)]:
    x, y, radius = int(S * px), int(S * py), int(S * pr)
    d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=(160, 230, 255, 235))

# 水面弧
d.arc([int(S * 0.14), int(S * 0.62), int(S * 0.86), int(S * 0.98)], 200, 340, fill=(56, 132, 255, 255), width=int(S * 0.028))

out = img.resize((256, 256), Image.LANCZOS)
out.save(r"E:\QQbot\app\icon.ico", format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
out.save(r"E:\QQbot\app\icon.png", format="PNG")
print("icon written")
