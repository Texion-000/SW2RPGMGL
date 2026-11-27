
# [switch2-preload-compat-v2]
# Appended to romfs:/preload/win32api_stub.rb by scripts/patch-mkxpz-switch2.py.

# --- Structured MKXP-Z diagnostic summary written to sdmc:/switch/SW2RPGMGL/log/mkxpz.log at boot
begin
	module SW2Diag
		VERSION = "0.3.2"
		RGSS_NAMES = {
			1 => "RPG Maker XP (RGSS1)",
			2 => "RPG Maker VX (RGSS2)",
			3 => "RPG Maker VX Ace (RGSS3)",
		}

		def self.utf8(s)
			s.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?")
		end

		def self.emit
			cwd = utf8(Dir.pwd)
			folder = utf8(File.basename(cwd))
			ini_path = %w[Game.ini game.ini].map { |n| File.join(cwd, n) }.find { |p| File.file?(p) }
			ini_fields = {}
			if ini_path
				raw_ini = File.binread(ini_path) rescue ""
				utf8(raw_ini).each_line do |ln|
					if ln =~ /\A\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*\z/
						ini_fields[$1.downcase] = $2
					end
				end
			end

			rgss = if defined?(::RGSS_VERSION)
				3
			elsif ini_fields["library"].to_s =~ /rgss3/i || File.file?(File.join(cwd, "Game.rgss3a")) || File.file?(File.join(cwd, "Data/Scripts.rvdata2"))
				3
			elsif ini_fields["library"].to_s =~ /rgss2/i || File.file?(File.join(cwd, "Game.rgss2a")) || File.file?(File.join(cwd, "Data/Scripts.rvdata"))
				2
			elsif ini_fields["library"].to_s =~ /rgss1/i || File.file?(File.join(cwd, "Game.rgssad")) || File.file?(File.join(cwd, "Data/Scripts.rxdata"))
				1
			else
				defined?(RPG::Cache) ? 1 : 2
			end

			title = (System.game_title rescue "").to_s.strip
			title = ini_fields["title"].to_s.strip if title.empty?
			title = folder if title.empty?

			archives = []
			(Dir.entries(cwd) rescue []).sort.each do |e|
				next unless e =~ /\.(rgss3a|rgss2a|rgssad|enc)\z/i
				sz = (File.size(File.join(cwd, e)) rescue 0) / (1024.0 * 1024.0)
				archives << format("%s (%.1f MiB)", utf8(e), sz)
			end
			unpacked_scripts = %w[Data/Scripts.rvdata2 Data/Scripts.rvdata Data/Scripts.rxdata Data/xScripts.rxdata].select do |rel|
				File.file?(File.join(cwd, rel))
			end
			essentials = File.file?(File.join(cwd, "Data/PluginScripts.rxdata")) || File.directory?(File.join(cwd, "PBS"))
			enc_summary = if !archives.empty?
				"Encrypted RGSS Archive [#{archives.join(', ')}]" + (unpacked_scripts.empty? ? "" : " + unpacked [#{unpacked_scripts.join(', ')}]")
			elsif !unpacked_scripts.empty?
				"Unencrypted (#{unpacked_scripts.join(', ')})"
			else
				"Custom / Unknown (scripts=#{ini_fields['scripts'] || 'default'})"
			end

			dlls = []
			[cwd, File.join(cwd, "System")].each do |d|
				next unless File.directory?(d)
				(Dir.entries(d) rescue []).each do |f|
					dlls << utf8(f) if f =~ /\.dll\z/i
				end
			end
			dlls.uniq!

			rtps = %w[
				sdmc:/switch/SW2RPGMGL/RPGVXAce
				sdmc:/switch/SW2RPGMGL/rtp-vxace
				sdmc:/switch/SW2RPGMGL/rtp-vx
				sdmc:/switch/SW2RPGMGL/rtp-xp
			].select { |p| File.directory?(p) }
			ini_rtps = ini_fields.select { |k, v| k.start_with?("rtp") && !v.empty? }.values

			saves = 0
			[cwd, File.join(cwd, "Save"), File.join(cwd, "save")].each do |sd|
				next unless File.directory?(sd)
				(Dir.entries(sd) rescue []).each do |f|
					saves += 1 if f =~ /\Asave.*\.(rvdata2|rvdata|rxdata)\z/i
				end
			end

			jp_map_count = 0
			jp_map_path = File.join(cwd, "_jp_map.txt")
			if File.file?(jp_map_path)
				(File.readlines(jp_map_path) rescue []).each { |l| jp_map_count += 1 if l.include?("\t") && !l.lstrip.start_with?("#") }
			end

			gw = (Graphics.width rescue "?")
			gh = (Graphics.height rescue "?")
			fps = (Graphics.frame_rate rescue "?")
			mkxp_cfg = %w[mkxp.json mkxp.conf].select { |n| File.file?(File.join(cwd, n)) }

			div = "=" * 72
			puts div
			puts "SW2RPGMGL v#{VERSION} — MKXP-Z Engine (mkxpz.log)"
			puts div
			puts "Time:         #{Time.now.utc.iso8601 rescue Time.now.to_s}"
			puts "Log File:     sdmc:/switch/SW2RPGMGL/log/mkxpz.log"
			puts "Game Title:   #{utf8(title)}"
			puts "Folder/Path:  #{folder}  (#{cwd})"
			puts "Engine:       #{RGSS_NAMES[rgss] || 'RGSS'}  |  Ruby #{RUBY_VERSION} (#{RUBY_PLATFORM})" +
			     (essentials ? "  |  Pokemon Essentials detected" : "")
			puts "Game.ini:     library=#{ini_fields['library'] || '(none)'}  |  scripts=#{ini_fields['scripts'] || '(default)'}" +
			     (ini_rtps.empty? ? "" : "  |  rtp=#{ini_rtps.join(', ')}")
			puts "Encryption:   #{enc_summary}"
			puts "Graphics:     #{gw}x#{gh} @ #{fps} Hz  |  GLES3 / OunceVK"
			puts "Mounted RTPs: #{rtps.empty? ? '(none on SD)' : rtps.join(', ')}"
			puts "Saves/Config: #{saves} save file(s)" +
			     (mkxp_cfg.empty? ? "" : "  |  config=[#{mkxp_cfg.join(', ')}]") +
			     (jp_map_count > 0 ? "  |  _jp_map.txt=#{jp_map_count} files" : "") +
			     (dlls.empty? ? "" : "  |  DLLs=[#{dlls.sort.join(', ')}]")
			puts "-" * 72
			$stdout.flush rescue nil
		end
	end
	SW2Diag.emit
rescue StandardError => e
	puts "[SW2Diag] warning: #{e.class}: #{e.message}" rescue nil
end

# --- Ruby 1.8 Thread.critical (removed in 1.9; used by weak-reference bitmap caches, e.g. Pokemon
#     Essentials' BitmapCache). mkxp-z threads are cooperative here, so a plain flag is equivalent.
class Thread
	class << self
		def critical; @__sw2_critical || false; end unless method_defined?(:critical)
		def critical=(v); @__sw2_critical = v; end unless method_defined?(:critical=)
	end
end

# --- Windows path separators: scripts build paths like "#{dir}\\Save1.rxdata". '\' is not a valid
#     filename character on the SD card (FAT32/exFAT), so translate it for Ruby's file APIs.
module SW2PathFix
	def self.fix(p)
		(p.is_a?(String) && p.include?("\\")) ? p.tr("\\", "/") : p
	end

	OPENERS = [:open, :new].freeze

	# Windows lets a file be opened for writing twice (To the Moon: File.new(f, "w") immediately followed
	# by open(f, "wb") without closing the first handle); the Switch SD card driver answers EIO.
	# Close this process's other handles to that path and retry once.
	def self.with_reopen(path, mode)
		yield
	rescue Errno::EIO, Errno::EACCES, Errno::EBUSY
		raise unless path.is_a?(String) && mode.to_s =~ /[wa+]/
		release_handles(path)
		yield
	end

	def self.release_handles(path)
		ObjectSpace.each_object(File) do |f|
			begin
				f.close if !f.closed? && f.path == path
			rescue StandardError
			end
		end
	end

	def self.wrap(target, names, all_args = false)
		mod = Module.new do
			names.each do |m|
				next unless target.respond_to?(m)
				reopen = OPENERS.include?(m)
				define_method(m) do |*a, **k, &b|
					if all_args
						a = a.map { |x| SW2PathFix.fix(x) }
					elsif !a.empty?
						a[0] = SW2PathFix.fix(a[0])
					end
					if reopen
						SW2PathFix.with_reopen(a[0], a[1] || k[:mode]) { k.empty? ? super(*a, &b) : super(*a, **k, &b) }
					else
						k.empty? ? super(*a, &b) : super(*a, **k, &b)
					end
				end
			end
		end
		target.singleton_class.prepend(mod)
	end
end
[File, Dir, FileTest].each do |c|
	c.singleton_class.send(:alias_method, :exists?, :exist?) if !c.respond_to?(:exists?) && c.respond_to?(:exist?)
end
SW2PathFix.wrap(File, [:open, :new, :exist?, :exists?, :file?, :directory?, :size, :size?, :zero?,
	:readable?, :writable?, :read, :readlines, :binread, :foreach, :mtime, :atime, :ctime, :stat, :lstat])
SW2PathFix.wrap(File, [:delete, :unlink, :rename, :binwrite, :write, :utime], true)
SW2PathFix.wrap(Dir, [:mkdir, :exist?, :exists?, :entries, :glob, :[], :rmdir, :delete, :unlink, :chdir,
	:foreach, :children, :each_child, :empty?])
SW2PathFix.wrap(FileTest, [:exist?, :exists?, :file?, :directory?, :size, :size?, :zero?])

# --- Custom launcher DLLs that only set environment variables or query fullscreen state.
module Win32API_Impl
	module Utils
		# Freebird Games (To the Moon / Finding Paradise): Utils.dll AVSetEnv exports AV_APPDATA, then
		# "Start Game" does ENV['AV_APPDATA'].rstrip to build the save folder path.
		class AVSetEnv
			def call(args)
				ENV['AV_APPDATA'] = ENV['APPDATA'] || File.join(Dir.pwd, "userdata", "AppData", "Roaming")
				1
			end
		end

		class IsFullScreen
			def call(args)
				1
			end
		end
	end
end

# --- RubyGems is not shipped; scripts that only `require 'rubygems'` (or need Gem::Version) get a stub.
unless defined?(Gem)
	module Gem
		VERSION = "3.3.26"
		def self.win_platform?; false; end
		def self.ruby_version; RUBY_VERSION; end

		class Version
			include Comparable
			def self.correct?(v)
				!!(v.to_s =~ /\A\s*[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z.-]+)?\s*\z/)
			end
			def self.create(v); v.is_a?(Version) ? v : new(v); end
			attr_reader :segments
			def initialize(v)
				@version = v.to_s.strip
				@segments = @version.split(/[.-]/).map { |s| s =~ /\A\d+\z/ ? s.to_i : s }
			end
			def <=>(other)
				other = Version.create(other) rescue (return nil)
				a = segments.dup; b = other.segments.dup
				n = [a.size, b.size].max
				a.fill(0, a.size...n); b.fill(0, b.size...n)
				a.zip(b).each do |x, y|
					next if x == y
					return (x.is_a?(Integer) && y.is_a?(Integer)) ? (x <=> y) : (x.to_s <=> y.to_s)
				end
				0
			end
			def to_s; @version; end
			alias version to_s
		end
	end
end
$LOADED_FEATURES << "rubygems.rb" unless $LOADED_FEATURES.any? { |f| f == "rubygems.rb" || f.end_with?("/rubygems.rb") }

# --- Kernel#open / IO.* with Windows '\' paths (To the Moon: open($appPath + "\\music.txt", "wb")).
module Kernel
	alias_method :__sw2_orig_open, :open
	private :__sw2_orig_open
	def open(*a, **k, &b)
		a[0] = SW2PathFix.fix(a[0]) unless a.empty?
		SW2PathFix.with_reopen(a[0], a[1] || k[:mode]) do
			k.empty? ? __sw2_orig_open(*a, &b) : __sw2_orig_open(*a, **k, &b)
		end
	end
	private :open
	module_function :open
end
SW2PathFix.wrap(IO, [:read, :readlines, :foreach, :binread, :sysopen])
SW2PathFix.wrap(IO, [:write, :binwrite], true)

# --- Ruby 1.8 semantics XP (RGSS1) scripts rely on (same as the official mkxp ruby18_comp.rb).
if defined?(RPG::Cache)
	class Array
		def to_s; join; end
	end
	class NilClass
		def id; 4; end
	end
end

# --- `require` fallback. mkxp-z ships no Ruby stdlib, and $LOAD_PATH entries such as "stdlib" (Pokemon
#     Reborn) or "sdmc:/..." do not resolve through Ruby's own lookup on Switch. When `require` fails:
#       1. a library compiled into mkxp-z (Zlib, ...) only needs to be marked loaded;
#       2. network libraries get offline stubs that raise SocketError (a StandardError, so update checks
#          that `rescue => e` keep booting);
#       3. otherwise search $LOAD_PATH, the game's stdlib/ lib/ gems/ folders and romfs:/stdlib for <name>.rb.
module SW2Require
	BUILTIN = { "zlib" => :Zlib, "stringio" => :StringIO, "fiddle" => :Fiddle, "etc" => :Etc,
		"json" => :JSON, "digest" => :Digest, "rbconfig" => :RbConfig, "thread" => :Thread,
		"enumerator" => :Enumerator, "rational" => :Rational, "complex" => :Complex, "fiber" => :Fiber,
		"monitor" => :Monitor, "objspace" => :ObjectSpace, "pathname" => :Pathname }
	# Compiled in only half way: the C part is built into mkxp-z, the methods written in Ruby (Pathname#parent,
	# #join, #children, ...) come from romfs:/stdlib/<name>.rb, which itself requires "<name>.so".
	SPLIT = %w[pathname]
	NETWORK = %w[socket net/http net/https net/protocol net/ftp net/smtp net/pop openssl open-uri resolv ipaddr]

	def self.absolute?(d)
		d.start_with?("/") || d =~ /\A[A-Za-z0-9_]+:\//
	end

	def self.abs(d)
		d = d.to_s
		absolute?(d) ? d : File.join(Dir.pwd, d)
	end

	def self.dirs
		list = []
		$LOAD_PATH.each { |d| list << abs(d) if d.is_a?(String) }
		%w[stdlib lib gems].each { |d| list << File.join(Dir.pwd, d) }
		list << "romfs:/stdlib"
		list.uniq
	end

	def self.find(base)
		return (File.file?(base + ".rb") ? base + ".rb" : nil) if absolute?(base)
		dirs.each do |d|
			path = "#{d}/#{base}.rb"
			return path if (File.file?(path) rescue false)
		end
		nil
	end

	def self.load_file(path)
		return false if $LOADED_FEATURES.include?(path)
		$LOADED_FEATURES << path
		begin
			TOPLEVEL_BINDING.eval(File.read(path), path)
		rescue Exception
			$LOADED_FEATURES.delete(path)
			raise
		end
		true
	end

	def self.network_stub(base)
		Object.const_set(:SocketError, Class.new(StandardError)) unless defined?(::SocketError)
		unless defined?(::Net::HTTP)
			Object.const_set(:Net, Module.new) unless defined?(::Net)
			http = Class.new do
				def self.offline(*); raise ::SocketError, "network access is not available on Switch"; end
				class << self
					%i[start get get_response get_print post post_form new].each { |m| alias_method m, :offline }
				end
			end
			%w[Get Post Head Put Delete].each { |c| http.const_set(c, Class.new { def initialize(*); end; def []=(*); end }) }
			::Net.const_set(:HTTP, http)
			::Net.const_set(:HTTPS, http) unless defined?(::Net::HTTPS)
			::Net.const_set(:OpenTimeout, Class.new(StandardError)) unless defined?(::Net::OpenTimeout)
			::Net.const_set(:ReadTimeout, Class.new(StandardError)) unless defined?(::Net::ReadTimeout)
		end
		unless defined?(::OpenSSL)
			Object.const_set(:OpenSSL, Module.new)
			::OpenSSL.const_set(:SSL, Module.new)
			::OpenSSL::SSL.const_set(:VERIFY_PEER, 1)
			::OpenSSL::SSL.const_set(:VERIFY_NONE, 0)
			::OpenSSL::SSL.const_set(:SSLError, Class.new(StandardError))
		end
		if base == "open-uri"
			begin; require "uri"; rescue LoadError; end
			if defined?(::URI) && !::URI.respond_to?(:open)
				::URI.define_singleton_method(:open) { |*| raise ::SocketError, "network access is not available on Switch" }
			end
		end
		$LOADED_FEATURES << "#{base}.rb"
		true
	end
end

module Kernel
	alias_method :__sw2_orig_require, :require
	private :__sw2_orig_require

	def require(name)
		loaded = __sw2_orig_require(name)
		# A statically linked C extension satisfies `require "pathname"` by itself, without its Ruby half
		base = name.to_s.sub(/\.rb\z/, "")
		if SW2Require::SPLIT.include?(base)
			const = SW2Require::BUILTIN[base]
			if const && Object.const_defined?(const) && (path = SW2Require.find(base))
				SW2Require.load_file(path)
			end
		end
		loaded
	rescue LoadError => e
		base = name.to_s.sub(/\.(rb|so|bundle|dll)\z/, "")
		feat = "#{base}.rb"
		return false if $LOADED_FEATURES.include?(feat)
		const = SW2Require::BUILTIN[base]
		split_ruby_half = SW2Require::SPLIT.include?(base) && !name.to_s.end_with?(".so")
		if const && Object.const_defined?(const) && !(split_ruby_half && SW2Require.find(base))
			$LOADED_FEATURES << feat
			return true
		end
		return SW2Require.network_stub(base) if SW2Require::NETWORK.include?(base)
		path = SW2Require.find(base)
		raise e unless path
		SW2Require.load_file(path)
	end
	private :require
	module_function :require

	def require_relative(name)
		loc = caller_locations(1, 1)[0]
		from = (loc.absolute_path || loc.path).to_s
		base = File.join(File.dirname(from), name.to_s)
		base = File.join(Dir.pwd, base) unless SW2Require.absolute?(base)
		path = base.end_with?(".rb") ? base : base + ".rb"
		raise LoadError, "cannot load such file -- #{base}" unless (File.file?(path) rescue false)
		SW2Require.load_file(path)
	end
	private :require_relative
	module_function :require_relative
end

# --- Extra Input constants from newer mkxp-z forks (Pokemon Reborn ships one): D/E/F, F3/F4,
#     PAGEUP/PAGEDOWN and KEY_<scancode> symbols for triggerex?. Unknown buttons resolve to
#     Input::None (0) so `trigger?(Input::E)` is simply false instead of a NameError.
if defined?(Input)
	module Input
		def self.const_missing(name)
			n = name.to_s
			value =
				if n.start_with?("KEY_") && n.length > 4
					n[4..-1].to_sym
				elsif n == "PAGEUP" && const_defined?(:L, false)
					const_get(:L)
				elsif n == "PAGEDOWN" && const_defined?(:R, false)
					const_get(:R)
				elsif n =~ /\A(?:[A-Z]|F\d{1,2}|[A-Z]+)\z/
					0
				else
					return super
				end
			const_set(name, value)
		end
	end
end

# --- Pathname: the C half is compiled into mkxp-z, so the class exists without its Ruby half and games that
#     use it (Pokemon Rejuvenation's NewGamePlus: Pathname#parent) hit NoMethodError, with or without
#     `require "pathname"`, which the C half alone satisfies. Load the Ruby half up front.
unless defined?(::Pathname) && ::Pathname.method_defined?(:parent)
	begin
		require "pathname"
		System.puts("[stdlib] Pathname#parent still missing after require") rescue nil unless ::Pathname.method_defined?(:parent)
	rescue LoadError, StandardError => e
		System.puts("[stdlib] pathname.rb not loaded: #{e.class}: #{e.message}") rescue nil
	end
end
