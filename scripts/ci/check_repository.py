"""Validate the documentation-stage repository without pretending to test the app."""

from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

import yaml


class StrictLoader(yaml.SafeLoader):
    """Reject duplicate keys and preserve the YAML 1.2 `on` workflow key."""


StrictLoader.yaml_implicit_resolvers = {
    key: [(tag, pattern) for tag, pattern in resolvers
          if tag != 'tag:yaml.org,2002:bool']
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
StrictLoader.add_implicit_resolver(
    'tag:yaml.org,2002:bool', re.compile(r'^(?:true|false|True|False|TRUE|FALSE)$'),
    list('tTfF'),
)


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'Duplicate YAML key: {key!r}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def load_yaml(text):
    documents = load_yaml_documents(text)
    if len(documents) != 1:
        raise ValueError('Expected exactly one YAML document.')
    return documents[0]


def load_yaml_documents(text):
    """Load a strict YAML stream while retaining duplicate-key checks."""
    return list(yaml.load_all(text, Loader=StrictLoader))


def check_workflow(data):
    if not isinstance(data, dict) or 'on' not in data or not data.get('jobs'):
        raise ValueError('Workflow needs events and jobs.')
    permissions = data.get('permissions')
    allowed_permissions = (
        {'contents': 'read'},
        {'contents': 'read', 'pull-requests': 'read'},
    )
    if permissions not in allowed_permissions:
        raise ValueError('Workflow permissions must be contents: read, optionally with pull-requests: read.')
    for job in data['jobs'].values():
        if not job.get('timeout-minutes'):
            raise ValueError('Every job needs a timeout.')
        for step in job.get('steps', []):
            action = step.get('uses')
            if not action:
                continue
            if not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', action):
                raise ValueError('Pin remote actions to a full commit SHA.')
            if action.startswith('actions/checkout@'):
                if step.get('with', {}).get('persist-credentials') is not False:
                    raise ValueError('Checkout must not persist credentials.')


def check_markdown(path, root):
    # Code examples are not document links. External URLs and anchors are not fetched.
    text = re.sub(r'(?ms)^```.*?^```[^\n]*$', '', path.read_text())
    for target in re.findall(r'!?\[[^\]]*\]\(([^\n)]+)\)', text):
        target = target.strip().split(' "', 1)[0].strip('<>')
        if not target or target.startswith('#') or re.match(r'[a-zA-Z][\w+.-]*:', target):
            continue
        target = unquote(target.split('#', 1)[0])
        if target.startswith('/'):
            raise ValueError(f'{path.relative_to(root)} contains a machine-local link.')
        resolved = (path.parent / target).resolve()
        if not resolved.is_relative_to(root) or not resolved.exists():
            raise ValueError(f'{path.relative_to(root)} has a missing or out-of-repository link: {target}')


def main():
    root = Path(__file__).resolve().parents[2]
    output = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root,
    )
    files = sorted({root / name.decode() for name in output.split(b'\0') if name})
    count = 0
    for path in files:
        if not path.is_file():
            continue
        if path.suffix in {'.yml', '.yaml'}:
            if path.name == 'pnpm-lock.yaml':
                documents = load_yaml_documents(path.read_text())
                if not documents or any(not isinstance(document, dict) for document in documents):
                    raise ValueError('PNPM lockfile must contain YAML mapping documents.')
            else:
                data = load_yaml(path.read_text())
                if path.parent == root / '.github/workflows':
                    check_workflow(data)
            count += 1
        elif path.suffix == '.md':
            check_markdown(path, root)
            if path.name == 'SKILL.md':
                text = path.read_text()
                if not text.startswith('---\n'):
                    raise ValueError(f'{path} needs YAML frontmatter.')
                metadata = load_yaml(text.split('---\n', 2)[1])
                if not isinstance(metadata, dict) or not all(
                    isinstance(metadata.get(key), str) and metadata[key].strip()
                    for key in ('name', 'description')
                ):
                    raise ValueError(f'{path} needs a skill name and description.')
            count += 1
    print(f'Repository configuration and local links passed ({count} files).')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, yaml.YAMLError) as error:
        print(f'Configuration check failed: {error}', file=sys.stderr)
        raise SystemExit(1)
