
# [switch2-win32-hooks-v1]
SW2_MODULE_NAME = Module.instance_method(:name) unless defined?(SW2_MODULE_NAME)
# Appended to scripts/preload/win32_wrap.rb by scripts/patch-mkxpz-switch2.py, i.e. after Win32API is
# defined. Native DLLs whose names are not valid Ruby constants ("RGSS Linker.dll", "RGSS FmodEx.dll")
# can't be dispatched through Win32API_Impl, so they are hooked here by (dll, function) name.
module SW2Win32Hooks
	HOOKS = {}

	def self.key(dll, func)
		[dll.to_s.downcase.sub(/\.dll\z/, "").strip, func.to_s.downcase]
	end

	def self.add(dll, func, &blk)
		HOOKS[key(dll, func)] = blk
	end

	def initialize(dll, func, *args)
		@sw2_hook = HOOKS[SW2Win32Hooks.key(dll, func)]
		return if @sw2_hook
		super
	end

	def call(*args)
		h = @sw2_hook
		return h.call(args) if h
		super
	end

	def Call(*args)
		call(*args)
	end
end
Win32API.prepend(SW2Win32Hooks) if defined?(Win32API)

# RGSS Linker (Nuri Yuri): native extension loader. Report success; the extensions themselves
# are provided as Ruby emulations below.
SW2Win32Hooks.add("RGSS Linker", "RGSSLinker_Initialize") { |_| 1 }

# RGSS FmodEx (Nuri Yuri): FMOD-based Audio replacement used by Pokemon Essentials games such as
# Pokemon Uranium. Emulate ::FmodEx on top of mkxp-z's own Audio module (captured before the game's
# script replaces the Audio functions with FmodEx-backed ones).
SW2Win32Hooks.add("RGSS FmodEx", "Init_FmodEx") do |_|
	unless defined?(::FmodEx)
		orig = {}
		%i[bgm_play bgm_fade bgm_stop bgs_play bgs_fade bgs_stop me_play me_fade me_stop se_play se_stop].each do |m|
			orig[m] = ::Audio.method(m) if ::Audio.respond_to?(m)
		end
		sound = Class.new do
			attr_accessor :volume, :pitch, :position, :length, :loop_start, :loop_end
			def initialize(file, volume, pitch)
				@file = file; @volume = volume; @pitch = pitch; @position = 0; @length = 0
			end
			def set_loop_points(first, last); @loop_start = first; @loop_end = last; true; end
			def playing?; true; end
			def paused?; false; end
			def stop; end
			def name; @file; end
		end
		mod = Module.new
		current = { bgm: nil, bgs: nil, me: nil }
		mod.define_singleton_method(:init) { |*| true }
		mod.define_singleton_method(:release) { |*| true }
		{ bgm: :bgm, bgs: :bgs, me: :me }.each do |kind, slot|
			mod.define_singleton_method(:"#{kind}_play") do |file, volume = 100, pitch = 100, *rest|
				orig[:"#{kind}_play"]&.call(file, volume, pitch)
				current[slot] = sound.new(file, volume, pitch)
			end
			mod.define_singleton_method(:"#{kind}_fade") { |time, *| orig[:"#{kind}_fade"]&.call(time); current[slot] = nil }
			mod.define_singleton_method(:"#{kind}_stop") { |*| orig[:"#{kind}_stop"]&.call; current[slot] = nil }
			mod.define_singleton_method(:"#{kind}_sound") { |*| current[slot] }
		end
		mod.define_singleton_method(:se_play) do |file, volume = 100, pitch = 100, *rest|
			orig[:se_play]&.call(file, volume, pitch)
			sound.new(file, volume, pitch)
		end
		mod.define_singleton_method(:se_stop) { |*| orig[:se_stop]&.call }
		Object.const_set(:FmodEx, mod)
	end
	0
end

# --- print / p / msgbox: on Switch SDL's native message box never appears, but mkxp-z waits for it to be
#     closed, so any RGSS1 `print` (Pokemon Essentials prints every caught exception that way) froze the game
#     on a black screen with no Quick Menu. Log the text and show it in-game instead; A/B dismisses it.
module SW2MsgBox
	def self.wrap_lines(text, width)
		out = []
		text.to_s.gsub("\r\n", "\n").split("\n", -1).each do |line|
			line = line.dup
			out << line.slice!(0, width) while line.length > width
			out << line
		end
		out
	end

	def self.show(text)
		text = text.to_s
		begin
			System.puts("[msgbox] #{text}")
		rescue StandardError
			$stderr.puts("[msgbox] #{text}") rescue nil
		end
		return nil if @showing || !defined?(Graphics) || !defined?(Sprite) || !defined?(Bitmap)
		@showing = true
		vp = spr = bmp = nil
		begin
			w = (Graphics.width rescue 640).to_i
			h = (Graphics.height rescue 480).to_i
			Graphics.transition(0) if Graphics.respond_to?(:frozen?) && Graphics.frozen?
			vp = Viewport.new(0, 0, w, h)
			vp.z = 0x7ffffff0
			spr = Sprite.new(vp)
			bmp = Bitmap.new(w, h)
			bmp.fill_rect(0, 0, w, h, Color.new(0, 0, 0, 215))
			bmp.font.size = 16 rescue nil
			bmp.font.color = Color.new(255, 255, 255) rescue nil
			cols = [(w - 40) / 8, 20].max
			lines = wrap_lines(text, cols)
			max = [(h - 70) / 20, 1].max
			lines = lines[0, max - 1] + ["..."] if lines.length > max
			lines.each_with_index { |l, i| bmp.draw_text(20, 16 + i * 20, w - 40, 20, l) }
			bmp.draw_text(0, h - 34, w, 24, "A / B: OK", 1)
			spr.bitmap = bmp
			# wait for release, then a fresh press
			5.times { Graphics.update; Input.update }
			loop do
				Graphics.update
				Input.update
				break if Input.trigger?(Input::C) || Input.trigger?(Input::B)
			end
		rescue StandardError, NotImplementedError
		ensure
			spr.dispose if spr && !spr.disposed? rescue nil
			bmp.dispose if bmp && !bmp.disposed? rescue nil
			vp.dispose if vp && !vp.disposed? rescue nil
			@showing = false
		end
		nil
	end
end

module Kernel
	# RGSS3 message boxes
	def msgbox(*args)
		SW2MsgBox.show(args.map(&:to_s).join)
		nil
	end
	def msgbox_p(*args)
		SW2MsgBox.show(args.map(&:inspect).join("\n"))
		args.length <= 1 ? args.first : args
	end
	module_function :msgbox, :msgbox_p

	# RGSS1/2: print and p are message boxes too (in RGSS3 they are plain console output, left alone)
	unless defined?(::RGSS_VERSION)
		def print(*args)
			SW2MsgBox.show(args.map(&:to_s).join)
			nil
		end
		def p(*args)
			SW2MsgBox.show(args.map(&:inspect).join("\n")) unless args.empty?
			args.length <= 1 ? args.first : args
		end
		module_function :print, :p
	end
end

# --- Ruby 1.8 String#[] in Pokemon Essentials' StringInput (files read from an encrypted archive):
#     getc must return the byte value (Integer). In Ruby 3 `@string[@pos]` is a 1-char String, so
#     fgetdw's `ret |= (i << x)` raised TypeError while reading Data/items.dat during boot.
#     Ruby 3's Marshal.load(io) also reads through #getbyte, which StringInput (an IO subclass that never
#     opened a descriptor) inherited from IO -> "IOError: uninitialized stream" when loading messages.
#     Hook every (re)definition of getc on StringInput via IO.inherited + method_added, so the fix sticks
#     no matter how many game scripts reopen the class.
module SW2StringInputFix
	FIXED = Module.new do
		def getc
			raise IOError, 'closed stream' if @closed
			ch = @string.getbyte(@pos)
			@pos += 1
			@pos += 1 if @pos == @string.bytesize
			ch
		end

		def getbyte
			getc
		end

		def readbyte
			b = getc
			raise EOFError, 'end of file reached' if b.nil?
			b
		end
	end

	def self.install(klass)
		return if klass.include?(FIXED)
		klass.prepend(FIXED)
	end
end

if defined?(RPG::Cache)
	class IO
		class << self
			alias_method :__sw2_inherited, :inherited
			def inherited(sub)
				__sw2_inherited(sub)
				# The constant is assigned after `inherited`, so check the name lazily from method_added.
				sub.define_singleton_method(:method_added) do |m|
					super(m) rescue nil
					SW2StringInputFix.install(self) if SW2_MODULE_NAME.bind_call(self) == "StringInput" && (m == :getc || m == :initialize)
				end
			end
		end
	end
end

# --- Diagnostics: opening the "-" Quick Menu logs where the game's Ruby code currently is. The menu runs
#     inside the game's own Graphics.update, so this pinpoints the loop a "stuck" game is spinning in.
#     Module#name is called unbound: games define their own `self.name` on modules (BMSP MapFog::Interface
#     reads $game_map, still nil while scripts load).
SW2_QUICKMENU_TRACE = TracePoint.new(:end) do |tp|
	m = tp.self
	next unless m.is_a?(Module) && SW2_MODULE_NAME.bind_call(m) == "SwitchControls" && m.respond_to?(:run_quick_menu)
	next if m.singleton_class.include?(SW2QuickMenuTrace)
	m.singleton_class.prepend(SW2QuickMenuTrace)
end
module SW2QuickMenuTrace
	def run_quick_menu(*args, &blk)
		begin
			stack = caller(1, 24).reject { |l| l.start_with?("romfs:") }
			System.puts("[quickmenu] opened from game code: " + stack.first(14).join("  <-  "))
		rescue StandardError
		end
		super
	end
end
SW2_QUICKMENU_TRACE.enable

# --- Audio API from newer mkxp-z forks (Pokemon Reborn): positional SE falls back to plain se_play,
#     bgm_position is the older name of bgm_pos.
if defined?(Audio)
	module Audio
		unless respond_to?(:se_play_position)
			def self.se_play_position(name, volume = 100, pitch = 100, *_pos)
				se_play(name, volume, pitch)
			end
		end
		if !respond_to?(:bgm_position) && respond_to?(:bgm_pos)
			def self.bgm_position(*a); bgm_pos(*a); end
		end
	end
end

# --- Pokemon Reborn's own mkxp-z build has a native TilemapUtils (Scene_Map calls
#     TilemapUtils.updateAutoTiles every frame). mkxp-z's built-in Tilemap animates autotiles by itself.
unless defined?(TilemapUtils)
	module TilemapUtils
		def self.updateAutoTiles(*); end
		def self.method_missing(*); nil; end
		def self.respond_to_missing?(*); true; end
	end
end

# --- Ruby 1.8 byte semantics for Essentials' FileInputMixin readers (see binding source fixups) + one-shot
#     diagnostics of where a String "byte" came from.
module SW2Diag
	def self.byte(io, v)
		return v unless v.is_a?(String)
		unless @logged
			@logged = true
			begin
				m = io.class.instance_method(:getc) rescue nil
				System.puts("[diag] #{io.class} each_byte yielded a String; getc owner=#{m && m.owner} " 					"src=#{m && m.source_location.inspect} ancestors=#{io.class.ancestors.first(6).inspect}")
			rescue StandardError
			end
		end
		v.ord
	end
end

# --- Quick Menu "Open Keyboard" helpers (used by switch_controls.rb)
module SwitchControls
	# Input.text_input reports SDL's text-input state, which stays off on Switch (the system keyboard is
	# shown instead), so track what the game last requested.
	def self.text_input_active?
		return Input.sw2_text_wanted? if Input.respond_to?(:sw2_text_wanted?)
		Input.respond_to?(:text_input) && Input.text_input ? true : false
	rescue StandardError
		false
	end

	def self.reopen_keyboard
		Input.text_input = false
		Input.text_input = true
	rescue StandardError
	end
end

if defined?(Input) && Input.respond_to?(:text_input=)
	class << Input
		alias_method :__sw2_set_text_input, :text_input=
		def text_input=(v)
			@sw2_text_wanted = v ? true : false
			__sw2_set_text_input(v)
		end
		def sw2_text_wanted?
			@sw2_text_wanted ? true : false
		end
	end
end

# --- Ruby 1.8 shims that alias String#getbyte/setbyte/bytesize to []/[]=/size (Bitmap Export by Zeus81,
#     used in Pokemon Uranium) replace Ruby 3's native byte methods with character ones: getbyte then returns
#     Strings and setbyte(i, Integer) raises. They were only fillers for Ruby 1.8.6, which lacked the native
#     methods, so keep the native ones whenever a script aliases them to something else.
module SW2StringGuard
	NATIVE = {}
	%i[getbyte setbyte bytesize].each { |m| NATIVE[m] = String.instance_method(m) if String.method_defined?(m) }
end
class String
	class << self
		alias_method :__sw2_string_method_added, :method_added
		def method_added(m)
			__sw2_string_method_added(m)
			native = SW2StringGuard::NATIVE[m]
			return if native.nil? || @sw2_restoring
			cur = instance_method(m)
			return if cur.original_name == m && cur.source_location.nil?
			@sw2_restoring = true
			begin
				define_method(m, native)
				System.puts("[rgss18] kept native String##{m} (ignored Ruby 1.8 shim -> #{cur.original_name})") rescue nil
			ensure
				@sw2_restoring = false
			end
		end
	end
end

# --- RPG Maker XP has no Graphics.resize_screen: Pokemon Essentials XP games (Pokemon Uranium, 512x384)
#     ran on a patched RGSS player whose window was DEFAULTSCREENWIDTH x DEFAULTSCREENHEIGHT, so the game
#     draws only into the top-left corner of the 640x480 screen. The script loader calls check right after
#     the script that declares the size (binding-mri.cpp), switching mkxp-z to it unless already resized.
unless defined?(::RGSS_VERSION)
	module SW2EssentialsResolution
		NATIVE_RESIZE = Graphics.method(:resize_screen)
		NATIVE_WIDTH = Graphics.method(:width)
		NATIVE_HEIGHT = Graphics.method(:height)
		@checked = false
		def self.check
			return if @checked
			@checked = true
			return unless Object.const_defined?(:DEFAULTSCREENWIDTH) && Object.const_defined?(:DEFAULTSCREENHEIGHT)
			w = ::DEFAULTSCREENWIDTH.to_i
			h = ::DEFAULTSCREENHEIGHT.to_i
			return unless NATIVE_WIDTH.call == 640 && NATIVE_HEIGHT.call == 480
			return if w <= 0 || h <= 0 || w > 640 || h > 480 || (w == 640 && h == 480)
			System.puts("[screen] RPG Maker XP game declares #{w}x#{h}: resizing the screen") rescue nil
			NATIVE_RESIZE.call(w, h)
		rescue StandardError => e
			System.puts("[screen] resolution check failed: #{e.class}: #{e.message}") rescue nil
		end
	end
end
