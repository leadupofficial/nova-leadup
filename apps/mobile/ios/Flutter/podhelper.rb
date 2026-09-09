#!/usr/bin/env ruby
# Flutter pod helper script for iOS
# Reference implementation for podhelper.rb

def flutter_root
 generated_xcode_build_settings_path = File.expand_path(File.join('..', 'Flutter', 'Generated.xcconfig'), __FILE__)
 unless File.exist?(generated_xcode_build_settings_path)
 raise "#{generated_xcode_build_settings_path} must exist. If you're running pod install manually, make sure flutter pub get is executed first"
 end

 File.foreach(generated_xcode_build_settings_path) do |line|
 matches = line.match(/FLUTTER_ROOT\=(.*)/)
 return matches[1].strip if matches
 end
 raise "FLUTTER_ROOT not found in #{generated_xcode_build_settings_path}"
end

def flutter_application_path
 flutter_root
end

def flutter_install_all_ios_pods(ios_application_path = nil)
 ios_application_path ||= Dir.pwd
 # No-op: pod helper stub for CI compatibility
end

def flutter_additional_ios_build_settings(target)
 # No-op: stub for CI compatibility
end
