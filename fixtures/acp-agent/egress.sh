set -eu
test -s README
git rev-parse HEAD
git ls-remote --exit-code origin HEAD
npm view is-number version
bun -e 'if (!(await fetch("https://registry.npmjs.org/is-number/latest")).ok) process.exit(1)'
node --input-type=module -e 'if (!(await fetch("https://registry.npmjs.org/is-number/latest")).ok) process.exit(1)'

for host in 169.254.169.254 10.0.0.1 172.17.0.1; do
    test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://$host/")" = 403
    if curl --noproxy '*' -s --max-time 2 "http://$host/" >/dev/null; then exit 1; fi
done
echo blocked
