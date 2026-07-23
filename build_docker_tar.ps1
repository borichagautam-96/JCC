# This script builds the Docker image and correctly saves it in a format 
# that is compatible with older Docker daemons on the VM.

Write-Host "Building Docker image..."
docker build -t jcc-automation .

Write-Host "Saving image to jcc-automation.tar..."
docker save -o jcc-automation.tar jcc-automation

Write-Host "Done! You can now copy jcc-automation.tar to your VM and run 'docker load -i jcc-automation.tar'."
