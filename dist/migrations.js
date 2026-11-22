// GitHub's compare lists at most this many files; with that many we can't be sure we saw them all.
export const COMPARE_FILE_CAP = 300;
const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// A directory pattern as a regex over a whole directory path. `*` matches within one path segment.
function directoryPattern(pattern) {
    // `.`, `./` and `/` all mean the repo root, whose files have an empty directory.
    const segments = pattern
        .replace(/^\.?\/+|\/+$/g, '')
        .replace(/^\.$/, '')
        .split('/');
    return new RegExp(`^${segments.map((segment) => segment.split('*').map(escape).join('[^/]*')).join('/')}$`);
}
// Migration files sit directly in a listed directory. Files in subfolders don't count, so tool
// metadata such as drizzle's meta/_journal.json (rewritten by every migration) isn't flagged.
export function isMigrationFile(path, directories) {
    const slash = path.lastIndexOf('/');
    const directory = slash === -1 ? '' : path.slice(0, slash);
    return directories.some((pattern) => directoryPattern(pattern).test(directory));
}
export function pendingMigrations(files, directories) {
    const inside = (path) => isMigrationFile(path, directories);
    const relevant = files.filter((file) => inside(file.filename) || (file.previousFilename && inside(file.previousFilename)));
    // A file renamed into the folder is new there; one renamed within or out of it was changed.
    const isNew = (file) => file.status === 'added' || (file.status === 'renamed' && !(file.previousFilename && inside(file.previousFilename)));
    return {
        added: relevant.filter(isNew).map((file) => file.filename),
        changed: relevant.filter((file) => !isNew(file)).map((file) => file.filename),
        truncated: files.length >= COMPARE_FILE_CAP,
    };
}
