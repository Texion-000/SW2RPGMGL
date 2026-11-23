# loading_screen.rb  [switch2-loading-screen-v2]
# mkxp-z only presents a frame on Graphics.update, so the screen stays black while a game's scripts
# load, which takes a long time for big games (Pokemon Essentials with many plugins). Show the same
# loading screen as the SW2RPGMGL MV/MZ engines, and let the script loader (binding-mri.cpp) advance
# its progress bar with SW2Loading.step while the game's scripts are evaluated.
#
# Each frame is drawn at 1280x720 so it fills the 16:9 display like the MV/MZ screen; the game's own
# resolution is restored right after the frame is presented, before the next game script runs.
#
# The sprite is only visible while this screen presents a frame, so a game that draws (or freezes the
# screen) during loading never sees it; the last frame stays on screen until the game shows its own.

module SW2Loading
	BG = Color.new(13, 16, 24)
	TITLE = Color.new(241, 245, 255)
	ACCENT = Color.new(108, 140, 255)
	BAR_BG = Color.new(30, 38, 56)
	BAR = Color.new(92, 124, 250)
	TEXT = Color.new(255, 255, 255)
	DETAIL = Color.new(168, 181, 209)
	HINT = Color.new(115, 128, 158)
	MIN_INTERVAL = 0.25 # seconds between frames: each Graphics.update waits for the next frame
	ENGINES = { 1 => "RPG Maker XP", 2 => "RPG Maker VX", 3 => "RPG Maker VX Ace" }

	@sprite = nil
	@last = nil
	@update = Graphics.method(:update)
	# Native methods, saved before game scripts can override them (Pokemon Essentials: Graphics.width)
	@width = Graphics.method(:width)
	@height = Graphics.method(:height)
	@resize = Graphics.method(:resize_screen)
	W, H = 1280, 720
	FONT_SCALE = 1.25
	LATIN_FONT = "Liberation Sans"
	LATIN_TEXT = /\A[\u0000-ɏ -⁯]*\z/

	def self.now
		Process.clock_gettime(Process::CLOCK_MONOTONIC)
	end

	def self.clip(text, max)
		text = text.to_s
		text.length > max ? text[0, max - 1] + "…" : text
	end

	def self.engine_name(rgss)
		ENGINES[rgss] || (defined?(::RGSS_VERSION) ? ENGINES[3] : "RPG Maker XP / VX")
	end

	def self.draw(progress, status, detail = "", rgss = nil)
		w, h = W, H
		ow, oh = @width.call, @height.call
		if @sprite.nil? || @sprite.disposed?
			@sprite = Sprite.new
			@sprite.bitmap = Bitmap.new(w, h)
			@sprite.z = 0x7fffffff
		end
		b = @sprite.bitmap
		s = h / 720.0 # the MV/MZ layout is 1280x720
		px = lambda { |v| (v * s).round }
		margin = px.call(72)
		tw = w - margin * 2
		b.fill_rect(b.rect, BG)
		b.font.bold = false
		b.font.italic = false
		b.font.outline = false if b.font.respond_to?(:outline=)
		b.font.shadow = false if b.font.respond_to?(:shadow=)
		# Same sizes and top positions as the MV/MZ canvas text (textBaseline top); mkxp-z fonts render
		# smaller than canvas px sizes, hence FONT_SCALE. Liberation Sans (built into mkxp-z) for Latin
		# text; the game's default font otherwise, which usually covers its own language.
		text = lambda do |top, size, color, str|
			str = str.to_s
			fs = [px.call(size * FONT_SCALE), 9].max
			b.font.name = str.match?(LATIN_TEXT) ? LATIN_FONT : Font.default_name
			b.font.size = fs
			b.font.color = color
			b.draw_text(margin, px.call(top) - (fs * 0.12).round, tw, (fs * 1.3).round, str)
		end

		title = System.game_title.to_s
		title = "Loading..." if title.empty?
		text.call(76, 40, TITLE, clip(title, 36))
		text.call(130, 20, ACCENT, "SW2RPGMGL  •  #{engine_name(rgss)} (mkxp-z)")

		bar_w = tw
		bar_h = [px.call(18), 4].max
		bar_y = px.call(204)
		b.fill_rect(margin, bar_y, bar_w, bar_h, BAR_BG)
		fill = (bar_w * [[progress.to_f, 0.0].max, 1.0].min).round
		b.fill_rect(margin, bar_y, fill, bar_h, BAR) if fill > 0

		text.call(242, 24, TEXT, status)
		text.call(288, 18, DETAIL, clip(detail, 90)) unless detail.to_s.empty?
		text.call(720 - 54, 16, HINT, "Press Minus (-) anytime in-game for the Quick Menu")

		@resize.call(w, h) if ow != w || oh != h
		begin
			@sprite.visible = true
			@update.call
		ensure
			@sprite.visible = false
			@resize.call(ow, oh) if ow != w || oh != h
		end
		@last = now
	rescue StandardError => e
		System.puts("[loading_screen] #{e.class}: #{e.message}") rescue nil
	end

	# Called by the script loader before each game script is evaluated.
	def self.step(index, count, name, rgss)
		return if count <= 0
		if index >= count - 1
			draw(1.0, "Starting #{clip(System.game_title, 40)}…", "", rgss)
			finish
			return
		end
		return if @last && now - @last < MIN_INTERVAL
		draw(0.05 + 0.9 * index / count, "Loading game scripts (#{index + 1}/#{count})…",
		     name.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?"), rgss)
	end

	def self.finish
		return unless @sprite
		@sprite.bitmap.dispose if !@sprite.disposed? && @sprite.bitmap
		@sprite.dispose unless @sprite.disposed?
		@sprite = nil
	rescue StandardError
		@sprite = nil
	end
end

SW2Loading.draw(0.02, "Loading game scripts…")
