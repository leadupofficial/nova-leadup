/// NOVA component library — ports of the OpenDesign export.
///
/// Every widget here maps to a class in the exported CSS
/// (`nova-mobile.zip`); the originating selector is named in each widget's
/// doc comment so design and code can be diffed by hand.
///
/// This file previously held a single line re-exporting the avatar provider,
/// which is why the design directory had no components in it at all.
library;

export '../../avatar/avatar_provider.dart';
export '../../theme/nova_theme.dart';
export 'nova_avatar.dart';
export 'nova_avatar_rig.dart';
export 'nova_avatar_waveform.dart';
export 'nova_chat.dart';
export 'nova_controls.dart';
export 'nova_markdown.dart';
export 'nova_nav.dart';
export 'nova_surfaces.dart';
