import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Memory — port of `memory/memory.html`.
///
/// Search hits the server (`GET /api/v1/memories?search=`) rather than filtering
/// locally, so results reflect what is actually stored. Add and delete are real
/// writes that invalidate the list and the dashboard count.
class MemoryPage extends ConsumerStatefulWidget {
  const MemoryPage({super.key});

  @override
  ConsumerState<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends ConsumerState<MemoryPage> {
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final query = ref.watch(memorySearchProvider);
    final searching = query.trim().isNotEmpty;
    final memories = ref.watch(
      searching ? memorySearchResultsProvider : memoriesProvider,
    );

    return NovaScaffold(
      topBar: Row(
        children: [
          Expanded(child: Text('Memory', style: NovaTheme.heroName(c))),
          NovaIconButton(
            icon: Icons.add_rounded,
            tooltip: 'Add a memory',
            onTap: _addMemory,
          ),
        ],
      ),
      refresh: () async {
        ref.invalidate(memoriesProvider);
        ref.invalidate(memorySearchResultsProvider);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          NovaTextField(
            controller: _search,
            hint: 'Search what NOVA remembers…',
            prefixIcon: Icons.search_rounded,
            onSubmitted: (v) =>
                ref.read(memorySearchProvider.notifier).set(v),
            suffix: _search.text.isEmpty
                ? null
                : IconButton(
                    icon: Icon(Icons.close_rounded, color: c.muted, size: 18),
                    tooltip: 'Clear search',
                    onPressed: () {
                      _search.clear();
                      ref.read(memorySearchProvider.notifier).clear();
                    },
                  ),
          ),
          const SizedBox(height: NovaSpace.lg),
          memories.when(
            loading: () => const NovaStateView(
              loading: true,
              title: 'Loading memories',
            ),
            error: (e, _) => NovaStateView(
              icon: Icons.cloud_off_rounded,
              tone: NovaStateTone.error,
              title: 'Could not load memories',
              message: e.toString().replaceFirst(
                RegExp(r'^NovaApiException\(\d*\): '),
                '',
              ),
              actionLabel: 'Retry',
              onAction: () => ref.invalidate(memoriesProvider),
            ),
            data: (list) => list.isEmpty
                ? NovaStateView(
                    icon: Icons.auto_awesome_outlined,
                    title: searching
                        ? 'Nothing matches "$query"'
                        : 'Nothing remembered yet',
                    message: searching
                        ? 'Try a different word.'
                        : 'NOVA stores what matters so you do not have to repeat yourself.',
                    actionLabel: searching ? 'Clear search' : 'Add a memory',
                    onAction: searching
                        ? () {
                            _search.clear();
                            ref.read(memorySearchProvider.notifier).clear();
                          }
                        : _addMemory,
                  )
                : Column(
                    children: list
                        .map((m) => _MemoryTile(memory: m))
                        .toList(growable: false),
                  ),
          ),
        ],
      ),
    );
  }

  Future<void> _addMemory() async {
    final controller = TextEditingController();
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          left: NovaSpace.gutter,
          right: NovaSpace.gutter,
          top: NovaSpace.lg,
          bottom: MediaQuery.viewInsetsOf(sheetContext).bottom + NovaSpace.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Add a memory',
              style: NovaTheme.sectionHeading(context.nova),
            ),
            const SizedBox(height: NovaSpace.md),
            NovaTextField(
              controller: controller,
              hint: 'e.g. I prefer meetings before noon',
              autofocus: true,
              maxLines: 3,
            ),
            const SizedBox(height: NovaSpace.md),
            NovaPrimaryButton(
              label: 'Save',
              onPressed: () =>
                  Navigator.pop(sheetContext, controller.text.trim()),
            ),
          ],
        ),
      ),
    );

    if (text == null || text.isEmpty || !mounted) return;
    try {
      await ref.read(novaMutationsProvider).addMemory(content: text);
      if (!mounted) return;
      ref.invalidate(memoriesProvider);
      ref.invalidate(memorySearchResultsProvider);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), ''),
          ),
        ),
      );
    }
  }
}

class _MemoryTile extends ConsumerWidget {
  const _MemoryTile({required this.memory});

  final dynamic memory;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final created = memory.createdAt as DateTime?;

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: const EdgeInsets.all(NovaSpace.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(NovaRadius.control),
                border: Border.all(color: c.accent.withValues(alpha: 0.25)),
              ),
              child: const Text('💭', style: TextStyle(fontSize: 16)),
            ),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    memory.content as String,
                    style: NovaTheme.bubble(c),
                  ),
                  if (created != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      '${created.day}/${created.month}/${created.year}',
                      style: NovaTheme.msgLabel(c),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              icon: Icon(
                Icons.delete_outline_rounded,
                color: c.muted,
                size: 20,
              ),
              tooltip: 'Forget this',
              onPressed: () async {
                await ref
                    .read(novaMutationsProvider)
                    .deleteMemory(memory.id as String);
                ref.invalidate(memoriesProvider);
              },
            ),
          ],
        ),
      ),
    );
  }
}
